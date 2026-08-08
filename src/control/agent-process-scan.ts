/**
 * @implements spec/feature/session-shutdown.md — session-process-reaper の OS 観測
 */
import {
  ExcubitorClient,
  MAX_PROCESS_SNAPSHOT_AGE_MS,
  type ExcubitorProcessSnapshot,
} from "../excubitor/client.js";
import { createChildLogger } from "../shared/logger.js";
import { classifyKind, extractSessionId, type AgentKind } from "./agent-process-classify.js";

const log = createChildLogger("reaper");

export interface RunningAgentProc {
  pid: number;
  kind: AgentKind;
  sessionId: string | null;
  ageSec: number;
  cmd: string;
}

/** Excubitor snapshot から reaper 対象だけを抽出する (pure)。 */
export function runningAgentProcessesFromSnapshot(
  snapshot: ExcubitorProcessSnapshot,
  nowMs = Date.now(),
): RunningAgentProc[] {
  const out: RunningAgentProc[] = [];
  for (const process of snapshot.processes) {
    const cmd = process.command_line;
    const kind = classifyKind(cmd, process.name);
    if (!kind) continue;
    const ageSec = process.started_at == null
      ? 0
      : Math.max(0, Math.floor((nowMs - process.started_at) / 1000));
    out.push({
      pid: process.pid,
      kind,
      sessionId: kind === "agent-client" ? extractSessionId(cmd) : null,
      ageSec,
      cmd,
    });
  }
  return out;
}

/** Excubitor の共有 snapshot から列挙する。失敗・stale 時は安全側の空配列。 */
export async function scanAgentProcesses(
  client = new ExcubitorClient(),
  nowMs = Date.now(),
): Promise<RunningAgentProc[]> {
  try {
    const snapshot = await client.getProcessSnapshot();
    if (!Number.isFinite(snapshot.sampled_at) || nowMs - snapshot.sampled_at > MAX_PROCESS_SNAPSHOT_AGE_MS) {
      log.warn(
        { sampledAt: snapshot.sampled_at, ageMs: nowMs - snapshot.sampled_at },
        "excubitor process snapshot is stale; reaper scan skipped",
      );
      return [];
    }
    return runningAgentProcessesFromSnapshot(snapshot, nowMs);
  } catch (error) {
    log.warn(
      { err: error instanceof Error ? error.message : String(error) },
      "excubitor process snapshot unavailable; reaper scan skipped",
    );
    return [];
  }
}
