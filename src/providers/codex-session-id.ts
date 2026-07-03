export function codexSessionIdFromRecord(obj: unknown): string | null {
  if (!obj || typeof obj !== "object") return null;
  const rec = obj as Record<string, unknown>;
  const payload = rec.payload && typeof rec.payload === "object"
    ? (rec.payload as Record<string, unknown>)
    : null;
  for (const value of [
    payload?.session_id,
    payload?.id,
    rec.session_id,
    rec.id,
  ]) {
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
}
