import { describe, expect, it } from "vitest";
import { closeWorkMode, readWorkMode, withWorkMode } from "./work-mode.js";

describe("work mode record (CC-WM-INV-01)", () => {
  it("records a mode and keeps unrelated metadata keys", () => {
    const result = withWorkMode(JSON.stringify({ role_label: "x" }), { mode: "daily-goal-run", ref: "g1", since: 10 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.parse(result.metadata).role_label).toBe("x");
    expect(readWorkMode(result.metadata)).toEqual({ mode: "daily-goal-run", ref: "g1", since: 10 });
  });

  it("is idempotent for the same mode and ref", () => {
    const first = withWorkMode(null, { mode: "daily-goal-run", ref: "g1", since: 10 });
    if (!first.ok) throw new Error("unexpected");
    const again = withWorkMode(first.metadata, { mode: "daily-goal-run", ref: "g1", since: 99 });
    expect(again.ok).toBe(true);
    if (again.ok) expect(readWorkMode(again.metadata)?.since).toBe(10);
  });

  it("rejects another mode or another goal while one is active", () => {
    const first = withWorkMode(null, { mode: "consultation", since: 1 });
    if (!first.ok) throw new Error("unexpected");
    expect(withWorkMode(first.metadata, { mode: "daily-goal-run", ref: "g1", since: 2 })).toMatchObject({ ok: false, reason: "other_mode_active" });
    const goal = withWorkMode(null, { mode: "daily-goal-run", ref: "g1", since: 1 });
    if (!goal.ok) throw new Error("unexpected");
    expect(withWorkMode(goal.metadata, { mode: "daily-goal-run", ref: "g2", since: 2 }).ok).toBe(false);
  });

  it("closes only the matching mode so a new mode can be recorded", () => {
    const goal = withWorkMode(null, { mode: "daily-goal-run", ref: "g1", since: 1 });
    if (!goal.ok) throw new Error("unexpected");
    expect(readWorkMode(closeWorkMode(goal.metadata, "consultation"))).not.toBeNull();
    const closed = closeWorkMode(goal.metadata, "daily-goal-run", "g1");
    expect(readWorkMode(closed)).toBeNull();
    expect(withWorkMode(closed, { mode: "interactive", since: 3 }).ok).toBe(true);
  });

  it("treats broken metadata as no mode", () => {
    expect(readWorkMode("{broken")).toBeNull();
    expect(readWorkMode(JSON.stringify({ work_mode: { mode: "unknown" } }))).toBeNull();
  });
});
