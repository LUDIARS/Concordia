import { describe, expect, it } from "vitest";
import { selectContinuationTask, taskWaitReason, type PlanningTask } from "./continuation-plan.js";

const task = (id: string, extra: Partial<PlanningTask> = {}): PlanningTask => ({ id, status: "open", blockedBy: [], isCriticalPath: false, slackDays: null, criticalPathError: null, pullRequests: [], ...extra });
describe("Actio continuation plan", () => {
  it("selects executable critical work before ordinary work", () => {
    expect(selectContinuationTask([task("a"), task("b", { isCriticalPath: true })])?.id).toBe("b");
  });
  it("waits for unknown and incomplete dependencies", () => {
    const blocked = task("a", { blockedBy: ["b"], isCriticalPath: true });
    expect(selectContinuationTask([blocked])).toBeNull();
    expect(selectContinuationTask([blocked, task("b", { status: "done" })])?.id).toBe("a");
  });
  it("never executes blocked, cyclic or completed tasks", () => {
    expect(selectContinuationTask([task("a", { status: "blocked" }), task("b", { criticalPathError: "cycle" }), task("c", { status: "done" })])).toBeNull();
  });
  it("does not equate review success with merge or reflection", () => {
    const pr = { provider: "revisor" as const, repository: "LUDIARS/Concordia", id: "1", number: 1, url: null, head_sha: "a", reviewed_head_sha: "a", state: "open" as const, review: "test_ok", reflection: "unknown" as const, observed_at: "2026-09-26T00:00:00.000Z" };
    expect(taskWaitReason(task("a", { pullRequests: [pr] }), [])).toBeNull();
    expect(taskWaitReason(task("a", { pullRequests: [{ ...pr, state: "merged" }] }), [])).toBe("reflection");
  });
  it("continues in-progress work only for its existing worker", () => {
    const active = task("a", { status: "in_progress", workingSessionId: "worker" });
    expect(taskWaitReason(active, [], "worker")).toBeNull();
    expect(taskWaitReason(active, [], "other")).toBe("in_progress");
    expect(selectContinuationTask([active])).toBeNull();
  });
});
