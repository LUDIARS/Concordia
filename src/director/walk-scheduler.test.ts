import { describe, expect, it } from "vitest";
import { nextWalkDelayMs } from "./walk-scheduler.js";

const JST_OFFSET_MS = 9 * 3600_000;

/** JST の時刻 (h) を指す epoch-ms (適当な基準日 2026-09-01)。 */
function jst(hour: number, minute = 0): number {
  // 2026-09-01T00:00:00+09:00 = 2026-08-31T15:00:00Z
  const base = Date.UTC(2026, 7, 31, 15, 0, 0);
  return base + hour * 3600_000 + minute * 60_000;
}

function jstHourOf(ms: number): number {
  return Math.floor(((ms + JST_OFFSET_MS) % 86_400_000) / 3600_000);
}

describe("nextWalkDelayMs", () => {
  it("fires inside the active window and is not equally spaced", () => {
    const now = jst(12);
    const a = nextWalkDelayMs(now, () => 0.3);
    const b = nextWalkDelayMs(now, () => 0.8);
    expect(a).not.toBe(b);
    for (const delay of [a, b]) {
      const hour = jstHourOf(now + delay);
      expect(hour).toBeGreaterThanOrEqual(10);
      expect(hour).toBeLessThan(22);
    }
  });

  it("carries over waits that start outside the active window", () => {
    const nowNight = jst(23);
    const delay = nextWalkDelayMs(nowNight, () => 0.2);
    const fireHour = jstHourOf(nowNight + delay);
    expect(fireHour).toBeGreaterThanOrEqual(10);
    expect(fireHour).toBeLessThan(22);
    // 深夜開始なら少なくとも翌 10:00 までは待つ。
    expect(delay).toBeGreaterThanOrEqual(11 * 3600_000);
  });

  it("spills long draws into the next day's active window", () => {
    const now = jst(21, 30);
    // 大きな乱数 → 活動時間で数時間ぶんの待ち → 当日の残り 30 分では収まらない。
    const delay = nextWalkDelayMs(now, () => 0.9);
    const fireHour = jstHourOf(now + delay);
    expect(fireHour).toBeGreaterThanOrEqual(10);
    expect(fireHour).toBeLessThan(22);
    expect(delay).toBeGreaterThan(30 * 60_000);
  });

  it("never returns a sub-second delay", () => {
    expect(nextWalkDelayMs(jst(12), () => 0)).toBeGreaterThanOrEqual(1_000);
  });
});
