import { describe, expect, it } from "vitest";
import { mapRolloutRateLimitsToCostRate } from "./codex-rollout-rate.js";

/** 2026-09-04 の実測行 (5H 枠は廃止され、 primary が週間枠・secondary は null)。 */
function observedPayload() {
  return {
    type: "token_count",
    plan: undefined,
    rate_limits: {
      limit_id: "codex",
      primary: { used_percent: 64, window_minutes: 10080, resets_at: 1_788_747_931 },
      secondary: null,
      plan_type: "pro",
    },
  };
}

describe("mapRolloutRateLimitsToCostRate", () => {
  // primary を 5H と決め打っていた頃は、 週間の値が「5H 64%、 リセットは 3 日後」として
  // 記録され、 存在しない 5H の時系列がグラフに出ていた。
  it("classifies a window by its length, not by its position", () => {
    expect(mapRolloutRateLimitsToCostRate(observedPayload())).toEqual({
      used5h: null,
      usedWeekly: 64,
      reset5hAt: null,
      resetWeeklyAt: 1_788_747_931,
      plan: "pro",
    });
  });

  it("reads a 5H window whichever position it arrives in", () => {
    const payload = {
      rate_limits: {
        primary: { used_percent: 90, window_minutes: 10080, resets_at: 2000 },
        secondary: { used_percent: 30, window_minutes: 300, resets_at: 1000 },
        plan_type: "pro",
      },
    };

    expect(mapRolloutRateLimitsToCostRate(payload)).toMatchObject({
      used5h: 30,
      reset5hAt: 1000,
      usedWeekly: 90,
      resetWeeklyAt: 2000,
    });
  });

  it("keeps the plan when no window is readable", () => {
    expect(mapRolloutRateLimitsToCostRate({ rate_limits: { plan_type: "pro" } })).toEqual({
      used5h: null,
      usedWeekly: null,
      reset5hAt: null,
      resetWeeklyAt: null,
      plan: "pro",
    });
  });

  it("returns null when neither a window nor a plan is readable", () => {
    expect(mapRolloutRateLimitsToCostRate({ rate_limits: {} })).toBeNull();
    expect(mapRolloutRateLimitsToCostRate(null)).toBeNull();
    expect(mapRolloutRateLimitsToCostRate("nope")).toBeNull();
  });
});
