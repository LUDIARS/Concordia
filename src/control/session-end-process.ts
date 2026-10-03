import { isPidAlive, stopSessionByLictorPid, type StopResult } from "./stop-session.js";
import { scanAgentProcesses, type RunningAgentProc } from "./agent-process-scan.js";
import { matchesObservedProcessGeneration, parseAgentClientPid, parseLictorPid } from "./session-process-metadata.js";

export { SESSION_END_PENDING_AT_KEY, isSessionEndPending, isSessionEndPendingOlderThan, sessionEndPendingAt } from "./session-end-request-state.js";

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
  /** Recheck the durable request after process observation and before each stop. */
  isStillOwned?: () => boolean;
}

/**
 * 完了通知または期限超過時、記録済みの Lictor / agent-client PID を停止する。
 * PID が既に終了している場合は冪等な成功として扱う。
 */
export async function stopCompletedSessionProcesses(
  metadata: string | null,
  deps: CompletedSessionStopDeps = {},
): Promise<CompletedSessionStopResult> {
  const pids = [...new Set([parseLictorPid(metadata), parseAgentClientPid(metadata)].filter((pid): pid is number => pid != null))];
  const result: CompletedSessionStopResult = { ok: true, stopped: [], alreadyStopped: [], failed: [] };
  if (pids.length === 0) return result;

  const isAlive = deps.isAlive ?? isPidAlive;
  const stopProcess = deps.stopProcess ?? stopSessionByLictorPid;
  const observed = new Map((await (deps.scanProcesses ?? scanAgentProcesses)()).map((process) => [process.pid, process]));
  const nowSec = (deps.nowSec ?? (() => Date.now() / 1000))();

  for (const pid of pids) {
    if (deps.isStillOwned && !deps.isStillOwned()) {
      result.failed.push({ pid, error: "session-end request ownership changed" });
      continue;
    }
    if (!isAlive(pid)) {
      result.alreadyStopped.push(pid);
      continue;
    }
    const process = observed.get(pid);
    if (!process || !matchesObservedProcessGeneration(metadata, process.ageSec, nowSec)) {
      result.failed.push({ pid, error: "process generation does not match session ownership" });
      continue;
    }
    const stopped = await stopOnce(pid, () => {
      if (deps.isStillOwned && !deps.isStillOwned()) {
        return Promise.resolve({ ok: false, error: "session-end request ownership changed" });
      }
      return stopProcess(pid);
    });
    if (stopped.ok && !isAlive(pid)) result.stopped.push(pid);
    else if (stopped.ok) result.failed.push({ pid, error: "stop accepted but process still alive; reconciliation required" });
    else result.failed.push({ pid, error: stopped.error });
  }
  result.ok = result.failed.length === 0;
  return result;
}

/** Completion callbacks and overlapping reaper ticks share an in-flight OS action.
 * After restart there is no promise to reuse: OS observation is the reconciliation.
 */
const pendingStops = new Map<number, Promise<StopResult>>();

async function stopOnce(pid: number, stop: (pid: number) => Promise<StopResult>): Promise<StopResult> {
  const existing = pendingStops.get(pid);
  if (existing) return existing;
  const request = Promise.resolve().then(() => stop(pid));
  pendingStops.set(pid, request);
  try {
    return await request;
  } finally {
    if (pendingStops.get(pid) === request) pendingStops.delete(pid);
  }
}
