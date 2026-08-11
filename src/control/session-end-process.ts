import { isPidAlive, stopSessionByLictorPid, type StopResult } from "./stop-session.js";
import { scanAgentProcesses, type RunningAgentProc } from "./agent-process-scan.js";
import { matchesObservedProcessGeneration, parseAgentClientPid, parseLictorPid } from "./session-process-metadata.js";

export const SESSION_END_PENDING_AT_KEY = "session_end_pending_at";

export interface CompletedSessionStopResult {
  ok: boolean;
  stopped: number[];
  alreadyStopped: number[];
  failed: Array<{ pid: number; error: string }>;
}

export interface CompletedSessionStopDeps {
  isAlive?: (pid: number) => boolean;
  stopProcess?: (pid: number) => Promise<StopResult>;
  scanProcesses?: () => Promise<RunningAgentProc[]>;
  nowSec?: () => number;
}

export function isSessionEndPending(metadata: string | null): boolean {
  return sessionEndPendingAt(metadata) !== null;
}

/** `session_end_pending_at` が cutoff より前なら true。猶予切れ回収の再検証に使う。 */
export function isSessionEndPendingOlderThan(metadata: string | null, cutoff: number): boolean {
  const pendingAt = sessionEndPendingAt(metadata);
  return pendingAt !== null && Number.isFinite(cutoff) && pendingAt < cutoff;
}

function sessionEndPendingAt(metadata: string | null): number | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as Record<string, unknown>;
    const value = parsed[SESSION_END_PENDING_AT_KEY];
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * session-end 完了通知を受けた後だけ、記録済みの Lictor / agent-client PID を停止する。
 * PID が既に終了している場合は冪等な成功として扱う。
 */
export async function stopCompletedSessionProcesses(
  metadata: string | null,
  deps: CompletedSessionStopDeps = {},
): Promise<CompletedSessionStopResult> {
  const isAlive = deps.isAlive ?? isPidAlive;
  const stopProcess = deps.stopProcess ?? stopSessionByLictorPid;
  const observed = new Map((await (deps.scanProcesses ?? scanAgentProcesses)()).map((process) => [process.pid, process]));
  const nowSec = (deps.nowSec ?? (() => Date.now() / 1000))();
  const pids = [...new Set([parseLictorPid(metadata), parseAgentClientPid(metadata)].filter((pid): pid is number => pid != null))];
  const result: CompletedSessionStopResult = { ok: true, stopped: [], alreadyStopped: [], failed: [] };

  for (const pid of pids) {
    if (!isAlive(pid)) {
      result.alreadyStopped.push(pid);
      continue;
    }
    const process = observed.get(pid);
    if (!process || !matchesObservedProcessGeneration(metadata, process.ageSec, nowSec)) {
      result.failed.push({ pid, error: "process generation does not match session ownership" });
      continue;
    }
    const stopped = await stopProcess(pid);
    if (stopped.ok) result.stopped.push(pid);
    else result.failed.push({ pid, error: stopped.error });
  }
  result.ok = result.failed.length === 0;
  return result;
}
