import type { CostRate } from "../cost/cost-rate.js";

/** Forum投稿からの自動起動で選べるプロバイダ (現状 codex/claude の2択)。 */
export type ForumSpawnProvider = "codex" | "claude";

/**
 * 「空いている方」= 週間 rate-limit 枠の残量が多い方 (neco 2026-07-18 指示)。
 * codex は `codexRate.usedWeekly`、 claude は `claudeUsage.sevenDay.utilization`
 * (どちらも 0-100 の使用率%、 既存の cost-report と同じ指標)。 片方/両方が取得できない
 * 場合は claude を既定にする — この2値は best-effort fetch (`fetchCodexRateLimits` /
 * `fetchClaudeOAuthUsage`) で、 cost-report 表示でも同様に null-fallback を許容している。
 */
export function pickAvailableForumProvider(input: {
  codexRate: Pick<CostRate, "usedWeekly"> | null;
  claudeUsage: { sevenDay: { utilization: number } | null } | null;
}): ForumSpawnProvider {
  const codexRemain = remainingPct(input.codexRate?.usedWeekly ?? null);
  const claudeRemain = remainingPct(input.claudeUsage?.sevenDay?.utilization ?? null);
  if (codexRemain === null) return "claude";
  if (claudeRemain === null) return "codex";
  return codexRemain > claudeRemain ? "codex" : "claude";
}

function remainingPct(usedPct: number | null): number | null {
  if (usedPct === null) return null;
  return Math.max(0, Math.min(100, 100 - usedPct));
}
