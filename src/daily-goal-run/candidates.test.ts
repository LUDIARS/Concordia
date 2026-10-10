import { describe, expect, it } from "vitest";
import { buildCandidate, candidateId } from "./candidates.js";
import type { DailyGoal } from "./domain.js";

describe("buildCandidate (CC-DG-INV-01 / CC-DG-INV-08)", () => {
  it("orders Actio tasks by due date and includes yesterday's remaining items and continuing goals", () => {
    const candidate = buildCandidate({
      date: "2026-10-11", project: "Cc", repoPath: "r", now: 1,
      tasks: [
        { id: "late", title: "後", status: "pending", dueAt: null },
        { id: "soon", title: "先", status: "delegated", dueAt: "2026-10-11" },
        { id: "done", title: "済", status: "done", dueAt: "2026-10-01" },
      ],
      previousExhausted: [{ id: "g", remaining: [{ item: "判断", class: "human_judgment", questionId: 1 }, { item: "外部", class: "unachievable", reason: "停止" }] } as DailyGoal],
      running: [{ id: "g2", goalText: "継続中のゴール" } as DailyGoal],
    });
    expect(candidate.id).toBe(candidateId("2026-10-11", "Cc"));
    expect(candidate.actioTasks.map((t) => t.id)).toEqual(["soon", "late"]);
    expect(candidate.suggestedGoal).toBe("先 を完了させる");
    expect(candidate.carryover).toEqual([
      { goalId: "g", item: "判断", class: "human_judgment" },
      { goalId: "g", item: "外部", class: "unachievable", reason: "停止" },
    ]);
    expect(candidate.continuing).toEqual([{ goalId: "g2", goalText: "継続中のゴール" }]);
  });

  it("leaves the proposal empty when there is no material", () => {
    expect(buildCandidate({ date: "d", project: "p", repoPath: "r", now: 1, tasks: [], previousExhausted: [], running: [] }).suggestedGoal).toBe("");
  });
});
