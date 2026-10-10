import { describe, expect, it } from "vitest";
import { isCheckpointDue, newEvidenceKeys, planCheckpoint, waitingMinutes } from "./checkpoint-policy.js";
import type { DailyGoal, EvidenceSnapshot } from "./domain.js";

const snap = (keys: string[], tasks: Record<string, string> = {}): EvidenceSnapshot => ({
  items: keys.map((key) => ({ key, kind: "commit", summary: key, at: null })), taskStatuses: tasks, unavailable: [],
});

describe("planCheckpoint (受け入れ基準: 予算は確認で戻り、回答待ちでは戻らない)", () => {
  it("skips while waiting without touching the budget", () => {
    expect(planCheckpoint({ waiting: true, previous: null, current: snap(["commit:a"]) })).toEqual({ action: "skip_waiting" });
  });

  it("declares progress and resets the budget when evidence increased", () => {
    expect(planCheckpoint({ waiting: false, previous: snap(["commit:a"]), current: snap(["commit:a", "commit:b"]) }))
      .toEqual({ action: "progress", newEvidence: ["commit:b"], resetBudget: true });
  });

  it("sends a completion check without resetting the budget when nothing new arrived (does not stop)", () => {
    expect(planCheckpoint({ waiting: false, previous: snap(["commit:a"]), current: snap(["commit:a"]) }))
      .toEqual({ action: "completion", newEvidence: [], resetBudget: false });
  });

  it("counts an Actio task status change as evidence but ignores unknown statuses", () => {
    expect(newEvidenceKeys(snap([], { t1: "pending" }), snap([], { t1: "delegated" }))).toEqual(["actio:t1:delegated"]);
    expect(newEvidenceKeys(snap([], { t1: "pending" }), snap([], { t1: "unknown" }))).toEqual([]);
  });
});

describe("isCheckpointDue", () => {
  const goal = { status: "running", sessionId: "s", launchedAt: 0 } as DailyGoal;
  it("is due one interval after the launch or the last checkpoint", () => {
    expect(isCheckpointDue(goal, null, 59 * 60_000, 60)).toBe(false);
    expect(isCheckpointDue(goal, null, 60 * 60_000, 60)).toBe(true);
    expect(isCheckpointDue(goal, 60 * 60_000, 100 * 60_000, 60)).toBe(false);
    expect(isCheckpointDue({ ...goal, sessionId: undefined }, null, 999 * 60_000, 60)).toBe(false);
  });
  it("reports waiting minutes", () => { expect(waitingMinutes(0, 125 * 60_000)).toBe(125); });
});
