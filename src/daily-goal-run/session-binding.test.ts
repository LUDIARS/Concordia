import { describe, expect, it } from "vitest";
import { bindGoalToMetadata, releaseGoalFromMetadata } from "./session-binding.js";
import { readGoalFromMetadata } from "../control/goal.js";
import { readWorkMode } from "../work-modes/work-mode.js";
import type { DailyGoal } from "./domain.js";

const goal = { id: "g1", goalText: "出荷する" } as DailyGoal;

describe("session binding (CC-WM-INV-01 / CC-WM-INV-02)", () => {
  it("writes the explicit goal and the work mode, keeping other keys", () => {
    const bound = bindGoalToMetadata(JSON.stringify({ role_label: "x" }), goal, 5);
    expect(bound.ok).toBe(true);
    expect(readGoalFromMetadata(bound.metadata)).toEqual({ mode: "scoped", text: "デイリーゴール g1: 出荷する" });
    expect(readWorkMode(bound.metadata)).toEqual({ mode: "daily-goal-run", ref: "g1", since: 5 });
    expect(JSON.parse(bound.metadata).role_label).toBe("x");
  });

  it("refuses to overwrite another active mode", () => {
    const other = JSON.stringify({ work_mode: { mode: "consultation", ref: null, since: 1 } });
    const bound = bindGoalToMetadata(other, goal, 5);
    expect(bound.ok).toBe(false);
    expect(readWorkMode(bound.metadata)?.mode).toBe("consultation");
  });

  it("closes only its own mode when the goal stops", () => {
    const bound = bindGoalToMetadata(null, goal, 5);
    expect(readWorkMode(releaseGoalFromMetadata(bound.metadata, goal))).toBeNull();
    expect(readWorkMode(releaseGoalFromMetadata(bound.metadata, { ...goal, id: "other" }))).not.toBeNull();
  });
});
