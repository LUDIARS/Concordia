import { describe, it, expect } from "vitest";
import {
  isQuietHours,
  actionFrequencyMultiplier,
  QUIET_HOURS_FACTOR,
} from "../src/shared/quiet-hours.js";

/** ローカルタイムで時刻 h:m の Date を作る (getHours() が h を返す). */
function at(hour: number, minute = 0): Date {
  return new Date(2026, 4, 22, hour, minute, 0);
}

describe("quiet-hours 強制ルール (23:00–翌05:00)", () => {
  it("深夜帯 (23:00–翌04:59) は quiet hours", () => {
    expect(isQuietHours(at(23, 0))).toBe(true);
    expect(isQuietHours(at(23, 59))).toBe(true);
    expect(isQuietHours(at(0, 0))).toBe(true);
    expect(isQuietHours(at(2, 30))).toBe(true);
    expect(isQuietHours(at(4, 59))).toBe(true);
  });

  it("05:00 ちょうどで通常帯に戻る (境界は end 未満)", () => {
    expect(isQuietHours(at(5, 0))).toBe(false);
  });

  it("昼帯 (05:00–22:59) は quiet hours ではない", () => {
    expect(isQuietHours(at(5, 1))).toBe(false);
    expect(isQuietHours(at(12, 0))).toBe(false);
    expect(isQuietHours(at(22, 59))).toBe(false);
  });

  it("係数は深夜帯で 1/10、 昼帯で 1", () => {
    expect(actionFrequencyMultiplier(at(2, 0))).toBe(QUIET_HOURS_FACTOR);
    expect(actionFrequencyMultiplier(at(2, 0))).toBeCloseTo(0.1);
    expect(actionFrequencyMultiplier(at(14, 0))).toBe(1);
    expect(actionFrequencyMultiplier(at(23, 30))).toBe(QUIET_HOURS_FACTOR);
    expect(actionFrequencyMultiplier(at(5, 0))).toBe(1);
  });
});
