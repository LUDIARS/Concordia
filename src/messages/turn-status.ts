import type { ConcordiaEvent } from "../events.js";
import type { SessionMessageRow } from "../db/session-messages-repo.js";
import type { ProjectedMessage } from "./project.js";

export const TURN_STATUS_KEY = "response-turn:current";
const TERMINAL = new Set(["completed", "interrupted", "failed"]);

/** @implements SPEC-CONSULTATION-TURN-STATUS — deterministic transition, no text or clock inference. */
export function projectTurnStatus(
  event: ConcordiaEvent, previous: SessionMessageRow | null, visible: boolean,
): ProjectedMessage | null {
  const old = previous?.metadata;
  if (event.type === "session.ended" || event.type === "session.lost") {
    if (old?.turn_status !== "started" || event.ts < Number(old.started_at)) return null;
    return message({ ...old, turn_status: "interrupted", ended_at: event.ts }, visible);
  }
  if (event.type !== "transcript.frame" || event.kind !== "turn") return null;
  const payload = record(event.payload);
  const status = payload.status;
  const id = payload.turn_id;
  const timestamp = payload.timestamp;
  if (status !== "started" && !TERMINAL.has(String(status))) return null;
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp <= 0 || timestamp > 8_640_000_000_000) return null;
  if (old && event.seq <= Number(old.last_seq)) return null;
  if (status === "started") {
    if (typeof id !== "string" || !id || id.length > 200) return null;
    if (old?.turn_id === id) return null;
    if (old && timestamp < Number(old.started_at)) return null;
    return message({ turn_id: id, turn_status: status, started_at: timestamp, ended_at: null, last_seq: event.seq }, visible);
  }
  // Claude's stop event has no turn ID: seq and source timestamp constrain it to the current turn.
  if (!old || old.turn_status !== "started" || (id != null && id !== old.turn_id)
    || timestamp < Number(old.started_at)) return null;
  return message({ ...old, turn_status: status, ended_at: timestamp, last_seq: event.seq }, visible);
}

function message(metadata: Record<string, unknown>, visible: boolean): ProjectedMessage {
  const label = metadata.turn_status === "started" ? "作業中…"
    : metadata.turn_status === "completed" ? "応答完了" : metadata.turn_status === "failed" ? "応答失敗" : "応答中断";
  const start = new Date(Number(metadata.started_at) * 1000).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
  return {
    op: "update", dedupe_key: TURN_STATUS_KEY, author_type: "system", author_label: "Response status",
    author_platform: null, content: `${label}（開始 ${start}）`,
    metadata: { ...metadata, response_turn: true, visible },
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
