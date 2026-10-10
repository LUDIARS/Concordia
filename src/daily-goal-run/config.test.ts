import { describe, expect, it } from "vitest";
import { DAILY_GOAL_SETTING_KEYS, resolveDailyGoalConfig } from "./config.js";

describe("resolveDailyGoalConfig", () => {
  it("uses defaults (07:30 / 60 min / no candidates) when unset", () => {
    expect(resolveDailyGoalConfig(() => null)).toEqual({ launchTime: "07:30", checkpointMinutes: 60, candidateProjects: [] });
  });

  it("reads stored values and rejects invalid ones", () => {
    const values: Record<string, string> = {
      [DAILY_GOAL_SETTING_KEYS.launchTime]: "8:05",
      [DAILY_GOAL_SETTING_KEYS.checkpointMinutes]: "30",
      [DAILY_GOAL_SETTING_KEYS.candidateProjects]: JSON.stringify(["Cc", " Ar ", ""]),
    };
    expect(resolveDailyGoalConfig((k) => values[k] ?? null)).toEqual({ launchTime: "08:05", checkpointMinutes: 30, candidateProjects: ["Cc", "Ar"] });
    expect(resolveDailyGoalConfig((k) => (k === DAILY_GOAL_SETTING_KEYS.checkpointMinutes ? "1" : k === DAILY_GOAL_SETTING_KEYS.candidateProjects ? "Cc;Ar" : "99:99")))
      .toEqual({ launchTime: "07:30", checkpointMinutes: 60, candidateProjects: ["Cc", "Ar"] });
  });
});
