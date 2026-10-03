/** Pure parser for the durable explicit-end request timestamp. */
export const SESSION_END_PENDING_AT_KEY = "session_end_pending_at";

export function sessionEndPendingAt(metadata: string | null): number | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as Record<string, unknown>;
    const value = parsed[SESSION_END_PENDING_AT_KEY];
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

export function isSessionEndPending(metadata: string | null): boolean {
  return sessionEndPendingAt(metadata) !== null;
}

export function isSessionEndPendingOlderThan(metadata: string | null, cutoff: number): boolean {
  const at = sessionEndPendingAt(metadata);
  return at !== null && Number.isFinite(cutoff) && at < cutoff;
}
