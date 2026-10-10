import { describe, expect, it } from "vitest";
import { candidateAt, isDue, launchAt, localDate, localTimeOn, nextDate, parseLaunchTime } from "./launch-policy.js";
import type { DailyGoal } from "./domain.js";

const at = (h: number, m: number) => new Date(2026, 9, 10, h, m).getTime();
const goal = (patch: Partial<DailyGoal> = {}): DailyGoal => ({
  id: "g", date: "2026-10-10", project: "p", repoPath: "r", goalText: "x", acceptance: ["a"], actioTaskIds: ["t"],
  permissions: { merge: false, test: false, service: false, deploy: false },
  confirmedBy: { platform: "discord", userId: "u", guildId: "g", channelId: "c" }, confirmedAt: at(6, 0),
  status: "confirmed", launchState: "none", createdAt: at(6, 0), ...patch,
});

describe("launch time (受け入れ基準: 7:30 までの確定は 7:30、以降は確定時)", () => {
  it("launches goals confirmed before 07:30 at 07:30", () => {
    expect(launchAt(at(6, 0), "2026-10-10")).toBe(at(7, 30));
    expect(isDue(goal(), at(7, 29))).toBe(false);
    expect(isDue(goal(), at(7, 30))).toBe(true);
  });

  it("launches goals confirmed after 07:30 immediately", () => {
    expect(launchAt(at(9, 15), "2026-10-10")).toBe(at(9, 15));
    expect(isDue(goal({ confirmedAt: at(9, 15) }), at(9, 15))).toBe(true);
  });

  it("honours a configured launch time and falls back on invalid values", () => {
    expect(launchAt(at(6, 0), "2026-10-10", "08:00")).toBe(at(8, 0));
    expect(parseLaunchTime("25:00")).toEqual({ hour: 7, minute: 30 });
    expect(localTimeOn("2026-10-10", "bad")).toBe(at(7, 30));
  });

  it("never re-launches a goal that already has a launch intent or is in backoff", () => {
    expect(isDue(goal({ launchState: "unknown" }), at(8, 0))).toBe(false);
    expect(isDue(goal({ status: "running", launchState: "launched" }), at(8, 0))).toBe(false);
    expect(isDue(goal({ nextLaunchAt: at(8, 10) }), at(8, 0))).toBe(false);
  });

  it("derives local dates and the candidate time 30 minutes before launch", () => {
    expect(localDate(at(23, 59))).toBe("2026-10-10");
    expect(nextDate("2026-10-31")).toBe("2026-11-01");
    expect(candidateAt("2026-10-10")).toBe(at(7, 0));
  });
});
