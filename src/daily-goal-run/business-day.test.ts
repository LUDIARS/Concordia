import { describe, expect, it } from "vitest";
import { addDays, businessDateOf, businessDayStart, deadlineOf, describeDeadline, parseClock } from "./business-day.js";

const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime();

describe("business day (用語: 朝 4:00 から翌朝 4:00、10/11 の 2:00 は 10/10)", () => {
  it("assigns times before the boundary to the previous business day", () => {
    expect(businessDateOf(at(11, 2))).toBe("2026-10-10");
    expect(businessDateOf(at(11, 3, 59))).toBe("2026-10-10");
    expect(businessDateOf(at(11, 4))).toBe("2026-10-11");
    expect(businessDateOf(at(10, 23, 59))).toBe("2026-10-10");
  });

  it("puts the deadline at the next day's boundary, so 0:00 is not a deadline", () => {
    expect(deadlineOf("2026-10-10")).toBe(at(11, 4));
    expect(businessDayStart("2026-10-10")).toBe(at(10, 4));
    expect(deadlineOf("2026-10-31")).toBe(new Date(2026, 10, 1, 4).getTime());
    expect(describeDeadline("2026-10-10")).toBe("10/11 04:00");
  });

  it("honours a configured boundary and falls back on invalid clocks", () => {
    expect(businessDateOf(at(11, 4, 30), "05:00")).toBe("2026-10-10");
    expect(parseClock("25:00", "04:00")).toEqual({ hour: 4, minute: 0 });
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
});
