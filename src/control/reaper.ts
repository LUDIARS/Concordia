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
 */

import { spawn } from "node:child_process";
import type { SessionsRepo } from "../db/sessions-repo.js";
import { stopSessionByLictorPid } from "./stop-session.js";
import { createChildLogger } from "../shared/logger.js";

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

/** active + lost の session から live な lictor_pid / session id 集合を作る。 */
export function liveSetsFromRepo(repo: SessionsRepo): {
  lictorPids: Set<number>;
  sessionIds: Set<string>;
} {
  const lictorPids = new Set<number>();
  const sessionIds = new Set<string>();
  for (const status of ["active", "lost"] as const) {
    for (const s of repo.listSessions({ status })) {
      sessionIds.add(s.id);
      const pid = parseLictorPid(s.metadata);
      if (pid != null) lictorPids.add(pid);
    }
  }
  return { lictorPids, sessionIds };
}

/** session.metadata (JSON 文字列) から lictor_pid を取り出す (pure)。 */
export function parseLictorPid(metadata: string | null): number | null {
  if (!metadata) return null;
  try {
    const m = JSON.parse(metadata) as { lictor_pid?: unknown };
    return typeof m.lictor_pid === "number" ? m.lictor_pid : null;
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

export interface ReapOptions {
  dryRun: boolean;
  minAgeSec: number;
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
  const { lictorPids, sessionIds } = liveSetsFromRepo(deps.repo);
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
  opts: { enabled: boolean; intervalMs: number; minAgeSec: number },
): ReaperHandle {
  const runOnce = () => reapOrphans(deps, { dryRun: false, minAgeSec: opts.minAgeSec });

  if (!opts.enabled) {
    log.info("reaper disabled (CONCORDIA_REAPER_ENABLED=0)");
    return { stop: () => {}, runOnce };
  }

  let timer: NodeJS.Timeout | null = null;
  const tick = async (): Promise<void> => {
    try {
      const r = await runOnce();
      if (r.killed.length > 0 || r.failed.length > 0) {
        log.info(
          { scanned: r.scanned, orphans: r.orphans.length, killed: r.killed.length, failed: r.failed.length },
          "reaped orphan processes",
        );
      }
    } catch (err) {
      log.warn({ err: (err as Error).message }, "reaper tick failed");
    }
  };

  timer = setInterval(() => void tick(), opts.intervalMs);
  timer.unref?.();
  log.info({ intervalMs: opts.intervalMs, minAgeSec: opts.minAgeSec }, "reaper started");
  // 起動直後に 1 回 (溜まった孤児を即回収)。
  void tick();

  return {
    stop: () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
    runOnce,
  };
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
