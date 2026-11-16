import { describe, expect, it } from "vitest";
import {
  EMPTY_NUDGE_STATE,
  needsReflectCheck,
  PATROL_ANSWER_MIN_DELAY_SEC,
  PATROL_REFLECT_GRACE_SEC,
  patrolNudgeIntervalSec,
  patrolNudgeToken,
  renderPatrolNudge,
  settleNudgeState,
  shouldReportUnresponsive,
  shouldSendPatrolNudge,
} from "./patrol-nudge-policy.js";

const MIN = 60;

describe("patrol nudge schedule", () => {
  it("waits 20, 40, 80 minutes between resends and caps at 2 hours", () => {
    expect([1, 2, 3, 4, 5].map(patrolNudgeIntervalSec)).toEqual([20 * MIN, 40 * MIN, 80 * MIN, 120 * MIN, 120 * MIN]);
  });

  it("sends at once to a stalled session, then only after the interval, and never to waiting sessions", () => {
    const now = 100_000;
    expect(shouldSendPatrolNudge("stalled", EMPTY_NUDGE_STATE, now)).toBe(true);
    const sent = { count: 1, lastAt: now, reportedAt: null };
    expect(shouldSendPatrolNudge("stalled", sent, now + 20 * MIN - 1)).toBe(false);
    expect(shouldSendPatrolNudge("stalled", sent, now + 20 * MIN)).toBe(true);
    expect(shouldSendPatrolNudge("unresponsive", { ...sent, count: 3 }, now + 80 * MIN)).toBe(true);
    for (const status of ["human_wait", "awaiting_result", "working", "end_candidate"] as const) {
      expect(shouldSendPatrolNudge(status, EMPTY_NUDGE_STATE, now)).toBe(false);
    }
  });

  it("counts again once the conversation moves after the last nudge", () => {
    const sent = { count: 2, lastAt: 1000, reportedAt: 900 };
    expect(settleNudgeState(sent, 999)).toBe(sent);
    expect(settleNudgeState(sent, null)).toBe(sent);
    expect(settleNudgeState(sent, 1000 + PATROL_ANSWER_MIN_DELAY_SEC)).toBe(sent);
    expect(settleNudgeState(sent, 1001 + PATROL_ANSWER_MIN_DELAY_SEC)).toEqual(EMPTY_NUDGE_STATE);
  });

  it("reports unresponsive once and checks reflection after the grace", () => {
    expect(shouldReportUnresponsive("unresponsive", { count: 3, lastAt: 1, reportedAt: null })).toBe(true);
    expect(shouldReportUnresponsive("unresponsive", { count: 3, lastAt: 1, reportedAt: 2 })).toBe(false);
    expect(shouldReportUnresponsive("stalled", { count: 2, lastAt: 1, reportedAt: null })).toBe(false);
    expect(needsReflectCheck({ count: 1, lastAt: 1000, reportedAt: null }, 1000 + PATROL_REFLECT_GRACE_SEC - 1)).toBe(false);
    expect(needsReflectCheck({ count: 1, lastAt: 1000, reportedAt: null }, 1000 + PATROL_REFLECT_GRACE_SEC)).toBe(true);
    expect(needsReflectCheck(EMPTY_NUDGE_STATE, 1_000_000)).toBe(false);
  });

  it("puts the token at the head of the nudge text", () => {
    const text = renderPatrolNudge({ count: 2, idleMinutes: 45, reason: "待つ理由なし" });
    expect(text.startsWith(patrolNudgeToken(2))).toBe(true);
    expect(text).toContain("無活動 45 分");
    expect(text).toContain("session-end");
  });
});
