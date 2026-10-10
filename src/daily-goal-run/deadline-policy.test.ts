import { describe, expect, it } from "vitest";
import { goalsPastDeadline, isNearDeadline, isPastDeadline } from "./deadline-policy.js";
import type { DailyGoal } from "./domain.js";

const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime();
const goal = (patch: Partial<DailyGoal>): DailyGoal => ({
  id: "g", date: "2026-10-10", project: "p", repoPath: "r", goalText: "x", acceptance: ["a"], actioTaskIds: [],
  permissions: { merge: false, test: false, service: false, deploy: false },
  confirmedBy: { platform: "discord", userId: "u", guildId: "g", channelId: "c" }, confirmedAt: 0,
  status: "running", launchState: "launched", createdAt: 0, ...patch,
});

describe("deadline (受け入れ基準: 4:00 に走っているゴールが締切で止まり、0:00 では止まらない)", () => {
  it("selects only active goals whose business day has ended", () => {
    const goals = [goal({ id: "run" }), goal({ id: "conf", status: "confirmed", launchState: "none" }), goal({ id: "done", status: "achieved" }),
      goal({ id: "next", date: "2026-10-11" })];
    expect(goalsPastDeadline(goals, at(11, 0), "04:00")).toEqual([]);
    expect(goalsPastDeadline(goals, at(11, 3, 59), "04:00")).toEqual([]);
    expect(goalsPastDeadline(goals, at(11, 4), "04:00").map((g) => g.id)).toEqual(["run", "conf"]);
  });

  it("reports past and near deadlines", () => {
    expect(isPastDeadline("2026-10-10", at(11, 4), "04:00")).toBe(true);
    expect(isPastDeadline("2026-10-10", at(11, 3), "04:00")).toBe(false);
    expect(isNearDeadline("2026-10-10", at(11, 3, 40), "04:00")).toBe(true);
    expect(isNearDeadline("2026-10-10", at(11, 3, 20), "04:00")).toBe(false);
  });
});
