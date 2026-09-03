/** `/v1/admin/spawn-session` の任意 emoji を永続化可能な短い値へ正規化する。 */
export function readSpawnEmoji(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 8 || /\s/.test(trimmed)) return null;
  return trimmed;
}
