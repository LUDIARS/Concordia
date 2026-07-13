/**
 * Codex の rate-limit (used%) とリセット時刻。 Claude は OAuth usage 側で持つ。
 * cost-report (描画) と codex-rate-limits (取得) の両方から参照されるため、
 * 循環 import を避けて独立モジュールに置く。
 */
export interface CostRate {
  used5h: number | null;
  usedWeekly: number | null;
  reset5hAt: number | null;
  resetWeeklyAt: number | null;
  plan: string | null;
}
