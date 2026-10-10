import { describe, expect, it } from "vitest";
import { DAILY_GOAL_SETTING_KEYS, resolveDailyGoalConfig } from "./config.js";

describe("resolveDailyGoalConfig", () => {
  it("uses defaults (60 min / 04:00 / 09:00) when unset", () => {
    expect(resolveDailyGoalConfig(() => null)).toEqual({ checkpointMinutes: 60, dayBoundary: "04:00", reminderTime: "09:00" });
  });

  it("reads stored values and rejects invalid ones", () => {
    const values: Record<string, string> = {
      [DAILY_GOAL_SETTING_KEYS.checkpointMinutes]: "30",
      [DAILY_GOAL_SETTING_KEYS.dayBoundary]: "5:00",
      [DAILY_GOAL_SETTING_KEYS.reminderTime]: "10:30",
    };
    expect(resolveDailyGoalConfig((k) => values[k] ?? null)).toEqual({ checkpointMinutes: 30, dayBoundary: "05:00", reminderTime: "10:30" });
    expect(resolveDailyGoalConfig((k) => (k === DAILY_GOAL_SETTING_KEYS.checkpointMinutes ? "1" : "99:99")))
      .toEqual({ checkpointMinutes: 60, dayBoundary: "04:00", reminderTime: "09:00" });
  });

  it("has no launch time or candidate settings (撤廃)", () => {
    expect(Object.keys(DAILY_GOAL_SETTING_KEYS)).toEqual(["checkpointMinutes", "dayBoundary", "reminderTime"]);
  });
});
