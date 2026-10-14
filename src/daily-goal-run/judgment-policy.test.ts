import { describe, expect, it } from "vitest";
import { isCheckpointDue, normalizeJudgment, reachedByJudgment } from "./judgment-policy.js";
import type { DailyGoal, EvidenceSnapshot } from "./domain.js";

const evidence: EvidenceSnapshot = {
  items: [
    { key: "pr:o#1:merged", kind: "pr", summary: "PR #1 merged", at: null },
    { key: "actio:t1:done", kind: "actio", summary: "Actio task t1 done", at: null },
  ],
  taskStatuses: { t1: "done" }, unavailable: [],
};
const acceptance = ["PR がマージされる", "task が完了する"];

describe("normalizeJudgment (CC-DG-INV-03)", () => {
  it("rejects an unknown verdict or a non-object", () => {
    expect(normalizeJudgment({ verdict: "great" }, acceptance, evidence)).toBeNull();
    expect(normalizeJudgment(null, acceptance, evidence)).toBeNull();
  });

  it("maps acceptance by number and keeps only refs that exist in the collected evidence", () => {
    const judged = normalizeJudgment({
      verdict: "on_track", reason: "  順調\nです ",
      acceptance: [
        { index: 1, outlook: "reached", refs: ["pr:o#1:merged", "pr:o#9:merged"] },
        { index: 2, outlook: "likely", refs: ["actio:t1:done", 3] },
        { index: 7, outlook: "reached", refs: ["pr:o#1:merged"] },
      ],
    }, acceptance, evidence);
    expect(judged).toEqual({
      verdict: "on_track", reason: "順調 です",
      acceptance: [
        { item: "PR がマージされる", outlook: "reached", refs: ["pr:o#1:merged"] },
        { item: "task が完了する", outlook: "likely", refs: ["actio:t1:done"] },
      ],
    });
  });

  it("never keeps reached without existing evidence and fills untouched items as at_risk", () => {
    const judged = normalizeJudgment({ verdict: "behind", acceptance: [{ index: 1, outlook: "reached", refs: ["commit:invented"] }] }, acceptance, evidence)!;
    expect(judged.acceptance).toEqual([
      { item: "PR がマージされる", outlook: "likely", refs: [] },
      { item: "task が完了する", outlook: "at_risk", refs: [] },
    ]);
    expect(judged.reason).toBe("(理由なし)");
  });
});

describe("reachedByJudgment (6. ゴール到達)", () => {
  it("reaches only when every acceptance item is reached with evidence", () => {
    const goal = { acceptance };
    const all = normalizeJudgment({ verdict: "on_track", reason: "x", acceptance: [
      { index: 1, outlook: "reached", refs: ["pr:o#1:merged"] }, { index: 2, outlook: "reached", refs: ["actio:t1:done"] },
    ] }, acceptance, evidence)!;
    expect(reachedByJudgment(goal, all)).toEqual({ reached: true, progress: { "PR がマージされる": ["pr:o#1:merged"], "task が完了する": ["actio:t1:done"] } });
    const partial = normalizeJudgment({ verdict: "on_track", reason: "x", acceptance: [
      { index: 1, outlook: "reached", refs: ["pr:o#1:merged"] }, { index: 2, outlook: "likely", refs: ["actio:t1:done"] },
    ] }, acceptance, evidence)!;
    expect(reachedByJudgment(goal, partial)).toEqual({ reached: false, progress: { "PR がマージされる": ["pr:o#1:merged"], "task が完了する": [] } });
  });
});

describe("isCheckpointDue", () => {
  const goal = { status: "running", confirmedAt: 0 } as DailyGoal;
  it("counts from the registration, then from the last checkpoint, and only for active goals", () => {
    expect(isCheckpointDue(goal, null, 59 * 60_000, 60)).toBe(false);
    expect(isCheckpointDue(goal, null, 60 * 60_000, 60)).toBe(true);
    expect(isCheckpointDue(goal, 60 * 60_000, 90 * 60_000, 60)).toBe(false);
    expect(isCheckpointDue({ ...goal, status: "confirmed" }, null, 60 * 60_000, 60)).toBe(true);
    expect(isCheckpointDue({ ...goal, status: "achieved" }, null, 600 * 60_000, 60)).toBe(false);
  });
});
