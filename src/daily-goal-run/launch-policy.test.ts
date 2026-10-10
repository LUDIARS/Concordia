import { describe, expect, it } from "vitest";
import { isDue } from "./launch-policy.js";
import type { DailyGoal } from "./domain.js";

const at = (h: number, m: number) => new Date(2026, 9, 10, h, m).getTime();
const goal = (patch: Partial<DailyGoal> = {}): DailyGoal => ({
  id: "g", date: "2026-10-10", project: "p", repoPath: "r", goalText: "x", acceptance: ["a"], actioTaskIds: [],
  permissions: { merge: false, test: false, service: false, deploy: false },
  confirmedBy: { platform: "discord", userId: "u", guildId: "g", channelId: "c" }, confirmedAt: at(5, 0),
  status: "confirmed", launchState: "none", createdAt: at(5, 0), ...patch,
});

describe("launch (受け入れ基準: 登録したらその場で起動し、7:30 の起動時刻は無い)", () => {
  it("is due immediately after registration, even before 07:30", () => {
    expect(isDue(goal(), at(5, 0))).toBe(true);
    expect(isDue(goal({ confirmedAt: at(23, 50) }), at(23, 50))).toBe(true);
  });

  it("waits only for the retry backoff and never relaunches a claimed or finished goal", () => {
    expect(isDue(goal({ nextLaunchAt: at(5, 10) }), at(5, 5))).toBe(false);
    expect(isDue(goal({ nextLaunchAt: at(5, 10) }), at(5, 10))).toBe(true);
    expect(isDue(goal({ launchState: "intent" }), at(6, 0))).toBe(false);
    expect(isDue(goal({ launchState: "unknown" }), at(6, 0))).toBe(false);
    expect(isDue(goal({ status: "running" }), at(6, 0))).toBe(false);
  });
});
