/** Weekly remaining quota policy for conversational patrols (CC-PATROL-10). */
export function choosePatrolProvider(
  remaining: { claude: number | null; codex: number | null },
  random: number,
): "claude" | "codex" {
  const valid = (n: number | null): n is number => n !== null && Number.isFinite(n) && n >= 0 && n <= 100;
  if (!valid(remaining.claude) || !valid(remaining.codex)) throw new Error("patrol_quota_unavailable");
  const { claude, codex } = remaining;
  if (claude >= 50 && codex >= 50) return random < 0.5 ? "claude" : "codex";
  if (claude >= 25 && codex < 25) return "claude";
  if (codex >= 25 && claude < 25) return "codex";
  if (claude === codex) return random < 0.5 ? "claude" : "codex";
  return claude > codex ? "claude" : "codex";
}
