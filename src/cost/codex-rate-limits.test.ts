import { describe, it, expect } from "vitest";
import { mapRateLimitsToCostRate } from "./codex-rate-limits.js";

describe("mapRateLimitsToCostRate", () => {
  it("実測レスポンス (weekly が primary / 5h 窓なし) を写像する", () => {
    // codex 0.144.1 の account/rateLimits/read 実測形 (2026-07-13)。
    const raw = {
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 8, windowDurationMins: 10080, resetsAt: 1784497715 },
        secondary: null,
        planType: "pro",
      },
    };
    expect(mapRateLimitsToCostRate(raw)).toEqual({
      used5h: null,
      usedWeekly: 8,
      reset5hAt: null,
      resetWeeklyAt: 1784497715,
      plan: "pro",
    });
  });

  it("5h + weekly の 2 窓は windowDurationMins で振り分ける (position 非依存)", () => {
    const raw = {
      rateLimits: {
        primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1784000000 },
        secondary: { usedPercent: 8, windowDurationMins: 10080, resetsAt: 1784497715 },
        planType: "plus",
      },
    };
    expect(mapRateLimitsToCostRate(raw)).toEqual({
      used5h: 42,
      usedWeekly: 8,
      reset5hAt: 1784000000,
      resetWeeklyAt: 1784497715,
      plan: "plus",
    });
    // 順序が逆でも同じ結果。
    const swapped = {
      rateLimits: {
        primary: raw.rateLimits.secondary,
        secondary: raw.rateLimits.primary,
        planType: "plus",
      },
    };
    expect(mapRateLimitsToCostRate(swapped)).toEqual(mapRateLimitsToCostRate(raw));
  });

  it("窓ゼロ / 形式不明は null (呼び出し元がセッション集計へフォールバック)", () => {
    expect(mapRateLimitsToCostRate(null)).toBeNull();
    expect(mapRateLimitsToCostRate({})).toBeNull();
    expect(mapRateLimitsToCostRate({ rateLimits: { primary: null, secondary: null } })).toBeNull();
    expect(mapRateLimitsToCostRate("nope")).toBeNull();
  });
});
