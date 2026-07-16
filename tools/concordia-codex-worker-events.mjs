/**
 * `codex exec --json` の session 開始イベントを CLI 世代差から吸収する。
 *
 * 旧 CLI は rollout と同じ `session_meta.payload.session_id`、現行 CLI は
 * `thread.started.thread_id` を stdout へ出す。worker は stdout だけを読めるため、
 * rollout file の schema を前提にしてはいけない。
 */
export function parseCodexSessionEvent(value) {
  if (!value || typeof value !== "object") return null;
  if (value.type === "session_meta") {
    const meta = objectOrEmpty(value.payload);
    const sessionId = firstString(meta.session_id, meta.id, meta.thread_id);
    return sessionId ? { sessionId, meta } : null;
  }
  if (value.type === "thread.started") {
    const payload = objectOrEmpty(value.payload);
    const sessionId = firstString(value.thread_id, payload.thread_id, payload.session_id, payload.id);
    return sessionId ? { sessionId, meta: payload } : null;
  }
  return null;
}

export function delegationTerminalUpdate(exitCode, sessionRegistered, stderr = "") {
  if (!sessionRegistered) {
    return {
      status: "failed",
      error: "Codex completed without registering a Concordia session (unsupported or missing start event)",
    };
  }
  if (exitCode === 0) return { status: "completed" };
  const detail = String(stderr).trim().slice(-1000);
  return {
    status: "failed",
    error: detail ? `Codex exited with code ${exitCode}: ${detail}` : `Codex exited with code ${exitCode}`,
  };
}

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}
