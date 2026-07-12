/**
 * 孤児プロセス回収 (reaper)。
 *
 * 終了したセッションの周辺プロセスが残留する問題の「回収」担当 (止血は kill 経路の配線、
 * これは既に残ってしまった分の掃除)。OS のプロセス一覧から Lictor ラッパ (`lictor.mjs`) と
 * agent-client (`concordia-agent-client.mjs`) を列挙し、 生きている session に紐付かないものを
 * 孤児と判定して kill する。
 *
 * 判定の安全側設計 (live work を絶対に殺さない):
 *  - lictor proc: pid が status active/lost の session.metadata.lictor_pid に含まれなければ孤児。
 *  - agent-client: `--session <id>` の id が status active/lost の session に無ければ孤児。
 *  - いずれも起動から minAgeSec 未満は見送る (登録レース回避: 起動直後で pid 未登録の可能性)。
 *  - active / lost は live 扱い (lost は復帰しうるので殺さない)。ended/abandoned/purged(行なし)のみ回収。
 *  - **session-end 進行中の保護 (安全弁):** ended になっても、 ended_at から endedGraceSec
 *    (既定 5 分) 以内は live 扱いで殺さない。 DELETE /v1/sessions/:id で status=ended に
 *    した直後から AI 側 session-end スキル (log 保存 / memory 更新 / Memoria 登録) が走り、
 *    その完了は `POST /v1/sessions/:id/session-end-done` → force-exit で確定的に閉じる。
 *    reaper がこの猶予内に割り込むと WT を巻き込んで「途中で終わる」事故になるため、
 *    猶予の間は kill を背後にキューしたまま session-end の終了を見届ける。
 */

import { spawn } from "node:child_process";
import type { SessionsRepo } from "../db/sessions-repo.js";
import { stopSessionByLictorPid } from "./stop-session.js";
import { createChildLogger } from "../shared/logger.js";
import { startSupervisedInterval } from "../shared/loop-bulkhead.js";

const log = createChildLogger("reaper");

export type AgentKind = "lictor" | "agent-client";

export interface RunningAgentProc {
  pid: number;
  kind: AgentKind;
  /** agent-client のみ: `--session <id>` から抽出。 lictor / 抽出失敗は null。 */
  sessionId: string | null;
  /** 起動からの経過秒。 */
  ageSec: number;
  cmd: string;
}

export interface OrphanProc extends RunningAgentProc {
  reason: string;
}

// ─── pure: cmdline 分類 ───────────────────────────────────────

/** cmdline から Lictor / agent-client / 対象外(null) を判定 (pure)。 */
export function classifyKind(cmd: string): AgentKind | null {
  if (/concordia-agent-client/i.test(cmd)) return "agent-client";
  if (/lictor\.mjs/i.test(cmd)) return "lictor";
  return null;
}

/** cmdline から `--session <id>` / `-s <id>` を抽出 (pure)。 無ければ null。 */
export function extractSessionId(cmd: string): string | null {
  const m = cmd.match(/(?:--session|-s)\s+(\S+)/);
  return m ? m[1]! : null;
}

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
 * @param liveLictorPids status active/lost の session が持つ lictor_pid 集合。
 * @param liveSessionIds status active/lost の session id 集合。
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
        out.push({ ...p, reason: "lictor_pid not referenced by any active/lost session" });
      }
    } else {
      if (!p.sessionId) {
        out.push({ ...p, reason: "agent-client without --session" });
      } else if (!liveSessionIds.has(p.sessionId)) {
        out.push({ ...p, reason: `session ${p.sessionId} not active/lost` });
      }
    }
  }
  return out;
}

/**
 * live な lictor_pid / session id 集合を作る。
 * active + lost は常に live。 加えて `endedGrace` を渡すと、 ended_at が
 * `nowSec - graceSec` 以降の ended セッション (= session-end 進行中) も live に含める。
 * これが「5 分間は安全弁でプロセスキルしない」 = session-end の途中で殺さない保護。
 */
export function liveSetsFromRepo(
  repo: SessionsRepo,
  endedGrace?: { nowSec: number; graceSec: number },
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
  for (const status of ["active", "lost"] as const) {
    for (const s of repo.listSessions({ status })) addLive(s);
  }
  // session-end 進行中 (ended から graceSec 以内) は live 扱いで保護する。
  if (endedGrace && endedGrace.graceSec > 0) {
    const floor = endedGrace.nowSec - endedGrace.graceSec;
    for (const s of repo.listSessions({ status: "ended" })) {
      if (s.ended_at != null && s.ended_at >= floor) addLive(s);
    }
  }
  return { lictorPids, sessionIds };
}

/** session.metadata (JSON 文字列) から lictor_pid を取り出す (pure)。 */
export function parseLictorPid(metadata: string | null): number | null {
  return parseMetaPid(metadata, "lictor_pid");
}

/** session.metadata から agent_client_pid を取り出す (pure)。 agent-client が起動時に自己登録する。 */
export function parseAgentClientPid(metadata: string | null): number | null {
  return parseMetaPid(metadata, "agent_client_pid");
}

function parseMetaPid(metadata: string | null, key: string): number | null {
  if (!metadata) return null;
  try {
    const m = JSON.parse(metadata) as Record<string, unknown>;
    return typeof m[key] === "number" ? (m[key] as number) : null;
  } catch {
    return null;
  }
}

// ─── OS 走査 ───────────────────────────────────────

/** OS から Lictor/agent-client プロセスを列挙する。 失敗時は空配列。 */
export async function scanAgentProcesses(): Promise<RunningAgentProc[]> {
  if (process.platform === "win32") {
    // node.exe に絞って pid / 起動からの経過秒 / cmdline を出す。
    const script =
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { " +
      "$age=[int]((Get-Date)-$_.CreationDate).TotalSeconds; " +
      "\"$($_.ProcessId)`t$age`t$($_.CommandLine)\" }";
    const out = await runCapture("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]);
    if (out == null) return [];
    return out.split(/\r?\n/).map(parseWindowsProcLine).filter((p): p is RunningAgentProc => p !== null);
  }
  const out = await runCapture("ps", ["-eo", "pid=,etimes=,args="]);
  if (out == null) return [];
  return out.split(/\r?\n/).map(parsePosixProcLine).filter((p): p is RunningAgentProc => p !== null);
}

/** ended セッションの保護猶予 (秒) の既定値 = 5 分。 */
export const DEFAULT_ENDED_GRACE_SEC = 300;

export interface ReapOptions {
  dryRun: boolean;
  minAgeSec: number;
  /**
   * ended_at がこの秒数以内の ended セッションは live 扱いで殺さない安全弁。
   * session-end スキル (log 保存 / memory 更新 / Memoria 登録) の実行中に reaper が
   * 割り込んで WT を巻き込み kill する事故を防ぐ。 既定 {@link DEFAULT_ENDED_GRACE_SEC} (5 分)。
   * 0 で無効 (旧挙動: ended は即回収対象)。
   */
  endedGraceSec?: number;
  /** 現在時刻 (秒)。 テスト注入用。 省略時は実時刻。 */
  nowSec?: number;
}

export interface ReapResult {
  scanned: number;
  orphans: OrphanProc[];
  killed: OrphanProc[];
  failed: Array<{ proc: OrphanProc; error: string }>;
}

/** 1 回の回収。 dryRun 時は kill せず孤児一覧だけ返す。 */
export async function reapOrphans(
  deps: { repo: SessionsRepo },
  opts: ReapOptions,
): Promise<ReapResult> {
  const procs = await scanAgentProcesses();
  const graceSec = opts.endedGraceSec ?? DEFAULT_ENDED_GRACE_SEC;
  const { lictorPids, sessionIds } = liveSetsFromRepo(
    deps.repo,
    graceSec > 0 ? { nowSec: opts.nowSec ?? nowSecReal(), graceSec } : undefined,
  );
  const orphans = classifyOrphans(procs, lictorPids, sessionIds, opts.minAgeSec);

  const killed: OrphanProc[] = [];
  const failed: Array<{ proc: OrphanProc; error: string }> = [];
  if (!opts.dryRun) {
    for (const o of orphans) {
      const r = stopSessionByLictorPid(o.pid);
      if (r.ok) killed.push(o);
      else failed.push({ proc: o, error: r.error });
    }
  }
  return { scanned: procs.length, orphans, killed, failed };
}

export interface ReaperHandle {
  stop: () => void;
  runOnce: () => Promise<ReapResult>;
}

/** 周期 reaper を起動する。 */
export function startReaper(
  deps: { repo: SessionsRepo },
  opts: { enabled: boolean; intervalMs: number; minAgeSec: number; endedGraceSec: number },
): ReaperHandle {
  const runOnce = () =>
    reapOrphans(deps, { dryRun: false, minAgeSec: opts.minAgeSec, endedGraceSec: opts.endedGraceSec });

  if (!opts.enabled) {
    log.info("reaper disabled (CONCORDIA_REAPER_ENABLED=0)");
    return { stop: () => {}, runOnce };
  }

  const tick = async (): Promise<void> => {
    const r = await runOnce();
    if (r.killed.length > 0 || r.failed.length > 0) {
      log.info(
        { scanned: r.scanned, orphans: r.orphans.length, killed: r.killed.length, failed: r.failed.length },
        "reaped orphan processes",
      );
    }
  };

  const supervised = startSupervisedInterval("reaper", tick, {
    intervalMs: opts.intervalMs,
    initialDelayMs: 0,
    log: { warn: (message) => log.warn(message) },
  });
  log.info(
    { intervalMs: opts.intervalMs, minAgeSec: opts.minAgeSec, endedGraceSec: opts.endedGraceSec },
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

/** stdout を集める軽量 spawn。 失敗・非 0 終了・timeout は null。 */
function runCapture(cmd: string, args: string[], timeoutMs = 15000): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { shell: false, windowsHide: true });
    let out = "";
    let settled = false;
    const done = (v: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      try { proc.kill("SIGTERM"); } catch { /* noop */ }
      done(null);
    }, timeoutMs);
    proc.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
    proc.on("error", () => done(null));
    proc.on("close", (code) => done(code === 0 ? out : null));
  });
}
