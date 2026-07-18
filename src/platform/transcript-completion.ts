/**
 * Whether a transcript frame represents a user-visible completion boundary.
 * Codex marks final answers explicitly; Claude-compatible providers may omit
 * phase on their final assistant frame. Summaries are always boundaries.
 */
export function isTranscriptCompletion(kind: string, payload: unknown): boolean {
  if (kind === "summary") return true;
  if (kind !== "text") return false;
  const value = payload as { role?: unknown; phase?: unknown } | null | undefined;
  if (value?.role !== "assistant") return false;
  return value.phase === undefined || value.phase === "final_answer";
}
