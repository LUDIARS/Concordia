import { describe, expect, it } from "vitest";
import { decideReminder, type ReminderInput } from "./reminder-policy.js";

const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime();
const input = (patch: Partial<ReminderInput> = {}): ReminderInput => ({
  now: at(10, 9), reminderAt: at(10, 9), deadlineAt: at(11, 4), reminderState: "none",
  hasGoal: false, hasDraft: false, noGoal: false, ...patch,
});

describe("decideReminder (受け入れ基準: 目標の無い日は 9:00 に 1 回だけ、目標なしの日は通知しない)", () => {
  it("notifies once at 09:00 on a day without goals, drafts or a no-goal declaration", () => {
    expect(decideReminder(input())).toBe("notify");
    expect(decideReminder(input({ now: at(10, 8, 59) }))).toBe("skip");
    expect(decideReminder(input({ reminderState: "queued" }))).toBe("skip");
    expect(decideReminder(input({ reminderState: "posted", now: at(10, 15) }))).toBe("skip");
  });

  it("skips days with a goal, a draft or 目標なし, and after the deadline", () => {
    expect(decideReminder(input({ hasGoal: true }))).toBe("skip");
    expect(decideReminder(input({ hasDraft: true }))).toBe("skip");
    expect(decideReminder(input({ noGoal: true }))).toBe("skip");
    expect(decideReminder(input({ now: at(11, 4) }))).toBe("skip");
  });
});
