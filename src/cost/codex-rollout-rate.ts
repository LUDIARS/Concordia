/**
 * Codex の rollout (`token_count` 行) から rate 枠を読む。
 *
 * `codex app-server` が使えないときの旧経路。 形は app-server のレスポンスと同じだが
 * キーが snake_case で、 窓長は `window_minutes`。
 *
 * 窓の 5H / 週間 への振り分けは position ではなく窓長で行う — `primary` を 5H と
 * 決め打つと、 5H 枠が廃止されて週間枠だけを返すアカウントで週間の値が 5H として
 * 記録される (実測 2026-09-04: primary が window_minutes 10080 で secondary が null
 * なのに「5H 64%、 リセットは 3 日後」という有り得ない時系列になっていた)。
 * 判定は app-server 側と同じ {@link mapRateLimitsToCostRate} に任せ、 1 箇所に保つ。
 */

import { mapRateLimitsToCostRate } from "./codex-rate-limits.js";
import type { CostRate } from "./cost-rate.js";

const EMPTY_RATE: CostRate = {
  used5h: null,
  usedWeekly: null,
  reset5hAt: null,
  resetWeeklyAt: null,
  plan: null,
};

/** rollout の `payload` から rate 枠を読む。 枠も plan も読めなければ null。 */
export function mapRolloutRateLimitsToCostRate(payload: unknown): CostRate | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  const rateLimits = (typeof p.rate_limits === "object" && p.rate_limits !== null
    ? p.rate_limits
    : {}) as Record<string, unknown>;
  const mapped = mapRateLimitsToCostRate({
    rateLimits: {
      primary: rolloutWindow(rateLimits.primary),
      secondary: rolloutWindow(rateLimits.secondary),
    },
  });
  const plan = firstString(
    p.plan,
    rateLimits.plan,
    rateLimits.plan_type,
    rateLimits.tier,
    rateLimits.subscription,
  );
  if (!mapped) return plan === null ? null : { ...EMPTY_RATE, plan };
  return { ...mapped, plan: plan ?? mapped.plan };
}

/** snake_case の窓を app-server 側の形へそろえる (分類は共通実装に任せる)。 */
function rolloutWindow(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return null;
  const w = value as Record<string, unknown>;
  return {
    usedPercent: finiteNumber(w.used_percent),
    windowDurationMins: finiteNumber(w.window_minutes ?? w.window_duration_mins),
    resetsAt: positiveEpoch(w.resets_at),
  };
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function positiveEpoch(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}
