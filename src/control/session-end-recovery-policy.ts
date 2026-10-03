/** Pure deadline and ownership decisions for one durable explicit-end request. */
import { sessionEndPendingAt } from "./session-end-request-state.js";
import { parseAgentClientPid, parseLictorPid, parseSessionProcessIdentity } from "./session-process-metadata.js";

/** Matches Lictor's existing maximum save window, independently of traffic. */
export const CONNECTED_SESSION_END_GRACE_SEC = 1800;

export interface SessionEndRecoveryRow {
  status: string;
  ws_clients: number;
  metadata: string | null;
}

export function hasSessionEndRecoveryExpired(row: SessionEndRecoveryRow, now: number, grace: number): boolean {
  if (row.status !== "ended" || !Number.isFinite(now) || !Number.isFinite(grace) || grace < 0) return false;
  const at = sessionEndPendingAt(row.metadata);
  const window = row.ws_clients > 0 ? Math.max(grace, CONNECTED_SESSION_END_GRACE_SEC) : grace;
  return at !== null && at < now - window;
}

/** Ignore unrelated metadata updates, but never transfer an old request to a new owner. */
export function isSameSessionEndRecoveryRequest(expected: SessionEndRecoveryRow, current: SessionEndRecoveryRow | null): boolean {
  if (!current || current.status !== "ended") return false;
  const at = sessionEndPendingAt(expected.metadata);
  if (at === null || at !== sessionEndPendingAt(current.metadata)) return false;
  const before = parseSessionProcessIdentity(expected.metadata);
  const after = parseSessionProcessIdentity(current.metadata);
  return before?.instanceId === after?.instanceId
    && before?.generationStartedAtMs === after?.generationStartedAtMs
    && parseLictorPid(expected.metadata) === parseLictorPid(current.metadata)
    && parseAgentClientPid(expected.metadata) === parseAgentClientPid(current.metadata);
}
