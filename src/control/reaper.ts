/**
 * 孤児プロセス回収 (reaper)。
 *
 * 終了したセッションの周辺プロセスが残留する問題の「回収」担当 (止血は kill 経路の配線、
 * これは既に残ってしまった分の掃除)。OS のプロセス一覧から Lictor ラッパ (`lictor.mjs`) と
 * agent-client (`concordia-agent-client.mjs`) を列挙し、 生きている session に紐付かないものを
 * 孤児と判定して kill する。
 *
 * 判定の安全側設計 (live work を絶対に殺さない):
 *  - lictor proc: pid が status active/lost/ended の session.metadata.lictor_pid に含まれなければ孤児。
 *  - lost session: 復帰猶予後もlost・WS未接続で、metadata PIDとOS上のlictor.mjsが一致すれば回収。
 *  - agent-client: `--session <id>` の id が status active/lost/ended の session に無ければ孤児。
 *  - いずれも起動から minAgeSec 未満は見送る (登録レース回避: 起動直後で pid 未登録の可能性)。
 *  - generic orphan判定ではactive/lost/endedをlive扱い。lostは専用判定で復帰猶予後だけ回収。
 *  - ended は時間経過で回収しない。session-end 完了通知がPIDを停止し、未完了でtrafficが
 *    途絶えた場合だけsweeperがlostへ移してlost専用判定に委ねる。
 */

import type { SessionsRepo } from "../db/sessions-repo.js";
import type { ControlJobsRepo } from "../db/control-jobs-repo.js";
import { stopSessionByLictorPid } from "./stop-session.js";
import {
  reapLostLictorProcesses,
  type LostLictorReapResult,
} from "./lost-session-process-reaper.js";
import {
  DEFAULT_SESSION_END_GRACE_SEC,
  reapExpiredSessionEnds,
  type ExpiredSessionEndReapResult,
} from "./expired-session-end-reaper.js";
import { parseAgentClientPid, parseLictorPid } from "./session-process-metadata.js";
export { parseAgentClientPid, parseLictorPid } from "./session-process-metadata.js";
import { classifyKind, extractSessionId } from "./agent-process-classify.js";
import {
  scanAgentProcesses,
  type RunningAgentProc,
} from "./agent-process-scan.js";
export { runningAgentProcessesFromSnapshot, scanAgentProcesses, type RunningAgentProc } from "./agent-process-scan.js";
export {
  classifyKind,
  extractSessionId,
  isShellWrapperCommand,
  type AgentKind,
} from "./agent-process-classify.js";
import { createChildLogger } from "../shared/logger.js";
import { startSupervisedInterval } from "../shared/loop-bulkhead.js";

const log = createChildLogger("reaper");

export interface OrphanProc extends RunningAgentProc {
  reason: string;
}

// ─── pure: cmdline 分類 ───────────────────────────────────────
//
// 分類そのものは agent-process-classify.ts が持つ (shell ラッパ除外を含む)。

/** Windows PowerShell 出力行 "pid\tageSec\tcmdline" を parse (pure)。 */
export function parseWindowsProcLine(line: string): RunningAgentProc | null {
  const tab = line.indexOf("\t");
  if (tab < 0) return null;
  const tab2 = line.indexOf("\t", tab + 1);
  if (tab2 < 0) return null;
  const pid = Number(line.slice(0, tab));
  const ageSec = Number(line.slice(tab + 1, tab2));
  const cmd = line.slice(tab2 + 1);
  if (!Number.isFinite(pid) || !Number.isFinite(ageSec)) return null;
  const kind = classifyKind(cmd);
  if (!kind) return null;
  return { pid, kind, sessionId: kind === "agent-client" ? extractSessionId(cmd) : null, ageSec, cmd };
}

/** POSIX `ps -eo pid=,etimes=,args=` の 1 行を parse (pure)。 */
export function parsePosixProcLine(line: string): RunningAgentProc | null {
  const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
  if (!m) return null;
  const pid = Number(m[1]);
  const ageSec = Number(m[2]);
  const cmd = m[3]!;
  const kind = classifyKind(cmd);
  if (!kind) return null;
  return { pid, kind, sessionId: kind === "agent-client" ? extractSessionId(cmd) : null, ageSec, cmd };
}

// ─── pure: 孤児判定 ───────────────────────────────────────

/**
 * 実行中の Lictor/agent-client から孤児を判定 (pure)。
 * @param liveLictorPids status active/lost/ended の session が持つ lictor_pid 集合。
 * @param liveSessionIds status active/lost/ended の session id 集合。
 * @param minAgeSec これ未満の若いプロセスは見送る (登録レース回避)。
 */
export function classifyOrphans(
  procs: RunningAgentProc[],
  liveLictorPids: Set<number>,
  liveSessionIds: Set<string>,
  minAgeSec: number,
): OrphanProc[] {
  const out: OrphanProc[] = [];
  for (const p of procs) {
    if (p.ageSec < minAgeSec) continue;
    if (p.kind === "lictor") {
      if (!liveLictorPids.has(p.pid)) {
        out.push({ ...p, reason: "lictor_pid not referenced by any active/lost/ended session" });
      }
    } else {
      if (!p.sessionId) {
        out.push({ ...p, reason: "agent-client without --session" });
      } else if (!liveSessionIds.has(p.sessionId)) {
        out.push({ ...p, reason: `session ${p.sessionId} not active/lost/ended` });
      }
    }
  }
  return out;
}

/**
 * live な lictor_pid / session id 集合を作る。
 * active + lost + ended は常に live。ended の停止はsession-end完了通知だけが担当し、
 * generic reaperは経過時間を根拠に終了処理へ割り込まない。
 */
export function liveSetsFromRepo(
  repo: SessionsRepo,
): {
  lictorPids: Set<number>;
  sessionIds: Set<string>;
} {
  const lictorPids = new Set<number>();
  const sessionIds = new Set<string>();
  const addLive = (s: { id: string; metadata: string | null }): void => {
    sessionIds.add(s.id);
    const pid = parseLictorPid(s.metadata);
    if (pid != null) lictorPids.add(pid);
  };
  for (const status of ["active", "lost", "ended"] as const) {
    for (const s of repo.listSessions({ status })) addLive(s);
  }
  return { lictorPids, sessionIds };
}

// ─── OS 走査 ───────────────────────────────────────

/** lost セッションがlive trafficで復帰するための猶予 (秒) の既定値 = 5 分。 */
export const DEFAULT_LOST_GRACE_SEC = 300;

export interface ReapOptions {
  dryRun: boolean;
  minAgeSec: number;
  /** lost化からこの秒数は復帰猶予としてLictor treeを保護する。既定5分。 */
  lostGraceSec?: number;
  /** session-end 完了通知を待つ猶予。超過した ended session を保険回収する。既定5分。 */
  sessionEndGraceSec?: number;
  /** 現在時刻 (秒)。 テスト注入用。 省略時は実時刻。 */
  nowSec?: number;
}

export interface ReapResult {
  scanned: number;
  lost: LostLictorReapResult;
  /** session-end 完了通知が猶予内に来なかった ended session の回収結果。 */
  expiredSessionEnds: ExpiredSessionEndReapResult;
  orphans: OrphanProc[];
  queued: Array<{ proc: OrphanProc; jobId: string; deduplicated: boolean }>;
  failed: Array<{ proc: OrphanProc; error: string }>;
}

/** 1 回の回収。 dryRun 時は kill せず孤児一覧だけ返す。 */
export async function reapOrphans(
  deps: {
    repo: SessionsRepo;
    controlJobs: Pick<ControlJobsRepo, "enqueueStopProcess">;
    scanProcesses?: () => Promise<RunningAgentProc[]>;
    stopProcess?: typeof stopSessionByLictorPid;
  },
  opts: ReapOptions,
): Promise<ReapResult> {
  const procs = await (deps.scanProcesses ?? scanAgentProcesses)();
  const nowSec = opts.nowSec ?? nowSecReal();
  const stopProcess = deps.stopProcess ?? stopSessionByLictorPid;
  const lost = await reapLostLictorProcesses(
    { repo: deps.repo, processes: procs, stopProcess },
    {
      dryRun: opts.dryRun,
      nowSec,
      graceSec: opts.lostGraceSec ?? DEFAULT_LOST_GRACE_SEC,
      minProcessAgeSec: opts.minAgeSec,
    },
  );
  // 通知が来なかった ended session の保険回収。orphan 判定より前に回して、
  // 停止できたものを次周期以降の孤児判定へ持ち込まない。
  const expiredSessionEnds = await reapExpiredSessionEnds(
    { repo: deps.repo },
    {
      dryRun: opts.dryRun,
      nowSec,
      graceSec: opts.sessionEndGraceSec ?? DEFAULT_SESSION_END_GRACE_SEC,
    },
  );
  const { lictorPids, sessionIds } = liveSetsFromRepo(deps.repo);
  const orphans = classifyOrphans(procs, lictorPids, sessionIds, opts.minAgeSec);

  const queued: ReapResult["queued"] = [];
  const failed: Array<{ proc: OrphanProc; error: string }> = [];
  if (!opts.dryRun) {
    for (const o of orphans) {
      try {
        const job = deps.controlJobs.enqueueStopProcess({
          pid: o.pid,
          source: "reaper",
          sessionId: o.sessionId,
          role: "orphan",
          expectedCommand: o.cmd,
          dedupeKey: `stop_process_tree:orphan:${o.pid}:${o.cmd}`,
        });
        queued.push({ proc: o, jobId: job.id, deduplicated: job.deduplicated });
      } catch (error) {
        failed.push({ proc: o, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return { scanned: procs.length, lost, expiredSessionEnds, orphans, queued, failed };
}

export interface ReaperHandle {
  stop: () => void;
  runOnce: () => Promise<ReapResult>;
}

/** 周期 reaper を起動する。 */
export function startReaper(
  deps: { repo: SessionsRepo; controlJobs: Pick<ControlJobsRepo, "enqueueStopProcess"> },
  opts: {
    enabled: boolean;
    intervalMs: number;
    minAgeSec: number;
    lostGraceSec: number;
    sessionEndGraceSec: number;
  },
): ReaperHandle {
  const runOnce = () =>
    reapOrphans(deps, {
      dryRun: false,
      minAgeSec: opts.minAgeSec,
      lostGraceSec: opts.lostGraceSec,
      sessionEndGraceSec: opts.sessionEndGraceSec,
    });

  if (!opts.enabled) {
    log.info("reaper disabled (CONCORDIA_REAPER_ENABLED=0)");
    return { stop: () => {}, runOnce };
  }

  const tick = async (): Promise<void> => {
    const r = await runOnce();
    if (
      r.queued.length > 0
      || r.failed.length > 0
      || r.lost.killed.length > 0
      || r.lost.failed.length > 0
      || r.expiredSessionEnds.stopped.length > 0
      || r.expiredSessionEnds.failed.length > 0
    ) {
      log.info(
        {
          scanned: r.scanned,
          lostCandidates: r.lost.candidates.length,
          lostKilled: r.lost.killed.length,
          lostSkipped: r.lost.skipped.length,
          lostFailed: r.lost.failed.length,
          expiredSessionEndStopped: r.expiredSessionEnds.stopped.length,
          expiredSessionEndFailed: r.expiredSessionEnds.failed.length,
          orphans: r.orphans.length,
          queued: r.queued.length,
          failed: r.failed.length,
        },
        "reaped lost session and orphan processes",
      );
    }
  };

  const supervised = startSupervisedInterval("reaper", tick, {
    intervalMs: opts.intervalMs,
    initialDelayMs: 0,
    log: { warn: (message) => log.warn(message) },
  });
  log.info(
    {
      intervalMs: opts.intervalMs,
      minAgeSec: opts.minAgeSec,
      lostGraceSec: opts.lostGraceSec,
      sessionEndGraceSec: opts.sessionEndGraceSec,
    },
    "reaper started",
  );
  return {
    stop: supervised.stop,
    runOnce,
  };
}

/** 現在時刻 (秒)。 grace 判定の基準。 */
function nowSecReal(): number {
  return Math.floor(Date.now() / 1000);
}
