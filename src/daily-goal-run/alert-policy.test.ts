import { describe, expect, it } from "vitest";
import { REALERT_AFTER_MS, decideProgressAlert, isPoorVerdict } from "./alert-policy.js";

const H = 60 * 60_000;
const clear = { streakSince: null, count: 0 };

describe("decideProgressAlert (CC-DG-INV-07 / CC-DG-INV-12)", () => {
  it("does not notify on track and clears the streak", () => {
    expect(decideProgressAlert(clear, "on_track", 1)).toEqual({ notify: false, next: clear });
    expect(decideProgressAlert({ streakSince: 1, count: 2 }, "on_track", 5 * H)).toEqual({ notify: false, next: clear });
  });

  it("notifies once at the start of a poor streak", () => {
    expect(decideProgressAlert(clear, "behind", 10)).toEqual({ notify: true, kind: "first", next: { streakSince: 10, count: 1 } });
    expect(decideProgressAlert({ streakSince: 10, count: 1 }, "stalled", 10 + H)).toEqual({ notify: false, next: { streakSince: 10, count: 1 } });
  });

  it("re-notifies exactly once after three hours, then stays quiet", () => {
    expect(REALERT_AFTER_MS).toBe(3 * H);
    expect(decideProgressAlert({ streakSince: 10, count: 1 }, "behind", 10 + 3 * H)).toEqual({ notify: true, kind: "repeat", next: { streakSince: 10, count: 2 } });
    expect(decideProgressAlert({ streakSince: 10, count: 2 }, "behind", 10 + 9 * H)).toEqual({ notify: false, next: { streakSince: 10, count: 2 } });
  });

  it("changes nothing when the judgment failed", () => {
    expect(decideProgressAlert({ streakSince: 10, count: 1 }, null, 10 + 5 * H)).toEqual({ notify: false, next: { streakSince: 10, count: 1 } });
    expect(decideProgressAlert(clear, null, 1)).toEqual({ notify: false, next: clear });
  });

  it("counts a new streak after recovery", () => {
    const recovered = decideProgressAlert({ streakSince: 10, count: 2 }, "on_track", 20).next;
    expect(decideProgressAlert(recovered, "stalled", 30)).toMatchObject({ notify: true, kind: "first" });
  });

  it("treats only behind and stalled as poor", () => {
    expect(isPoorVerdict("on_track")).toBe(false);
    expect(isPoorVerdict("behind")).toBe(true);
    expect(isPoorVerdict("stalled")).toBe(true);
  });
});
