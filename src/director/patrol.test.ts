import { describe, expect, it } from "vitest";
import { nextExecutableStep, planTeamPatrol, type PatrolRunView } from "./patrol.js";
import type { DirectorCase, DirectorStep, DirectorStepKind, DirectorStepStatus } from "./types.js";

function makeCase(id: string, createdAt = 100): DirectorCase {
  return {
    id,
    title: `case ${id}`,
    goal: "goal",
    project: "Cc",
    session_id: null,
    team_id: "team-1",
    created_at: createdAt,
    updated_at: createdAt,
  };
}

let stepSeq = 0;
function makeStep(
  caseId: string,
  kind: DirectorStepKind,
  status: DirectorStepStatus,
  overrides: Partial<DirectorStep> = {},
): DirectorStep {
  stepSeq += 1;
  return {
    id: overrides.id ?? `step-${stepSeq}`,
    case_id: caseId,
    sequence: overrides.sequence ?? stepSeq,
    kind,
    title: overrides.title ?? `${kind} step`,
    status,
    task_path: null,
    delegation_run_id: null,
    local_pr_id: null,
    confirm_run_id: null,
    handoff_note: null,
    created_at: 100,
    updated_at: 100,
    ...overrides,
  };
}

function runOf(status: PatrolRunView["status"], id = "run-1"): PatrolRunView {
  return { id, status };
}

describe("planTeamPatrol", () => {
  it("advances an active step whose delegation run completed", () => {
    const c = makeCase("c1");
    const step = makeStep("c1", "delegate", "active", { sequence: 1, delegation_run_id: "run-1" });
    const actions = planTeamPatrol({
      cases: [{ case: c, steps: [step] }],
      findRun: () => runOf("completed"),
    });
    expect(actions).toContainEqual({ type: "advance", caseId: "c1", stepId: step.id });
  });

  it("blocks and escalates when the delegation run failed", () => {
    const c = makeCase("c1");
    const step = makeStep("c1", "delegate", "active", { sequence: 1, delegation_run_id: "run-1" });
    const actions = planTeamPatrol({
      cases: [{ case: c, steps: [step] }],
      findRun: () => ({ ...runOf("failed"), error: "secret-bearing diagnostic" }),
    });
    expect(actions.some((a) => a.type === "block" && a.stepId === step.id)).toBe(true);
    expect(actions.some((a) => a.type === "escalate" && a.reason === "run-failed")).toBe(true);
    expect(JSON.stringify(actions)).not.toContain("secret-bearing diagnostic");
  });

  it("blocks and escalates when the referenced run row is missing", () => {
    const c = makeCase("c1");
    const step = makeStep("c1", "delegate", "active", { sequence: 1, delegation_run_id: "run-x" });
    const actions = planTeamPatrol({
      cases: [{ case: c, steps: [step] }],
      findRun: () => null,
    });
    expect(actions.some((a) => a.type === "block" && a.stepId === step.id)).toBe(true);
    expect(actions.some((a) => a.type === "escalate" && a.reason === "run-missing")).toBe(true);
  });

  it("launches the next executable pending delegate step", () => {
    const c = makeCase("c1");
    const done = makeStep("c1", "plan", "completed", { sequence: 1 });
    const pending = makeStep("c1", "delegate", "pending", { sequence: 2 });
    const actions = planTeamPatrol({
      cases: [{ case: c, steps: [done, pending] }],
      findRun: () => null,
    });
    expect(actions).toContainEqual({ type: "launch", caseId: "c1", stepId: pending.id });
  });

  it("does not launch when an earlier step is still blocked", () => {
    const c = makeCase("c1");
    const blocked = makeStep("c1", "plan", "blocked", { sequence: 1 });
    const pending = makeStep("c1", "delegate", "pending", { sequence: 2 });
    const actions = planTeamPatrol({
      cases: [{ case: c, steps: [blocked, pending] }],
      findRun: () => null,
    });
    expect(actions.filter((a) => a.type === "launch")).toHaveLength(0);
  });

  it("does not launch non-implementation kinds", () => {
    const c = makeCase("c1");
    const decompose = makeStep("c1", "decompose", "pending", { sequence: 1 });
    const actions = planTeamPatrol({
      cases: [{ case: c, steps: [decompose] }],
      findRun: () => null,
    });
    expect(actions.filter((a) => a.type === "launch")).toHaveLength(0);
  });

  it("respects the team concurrency slot occupied by a running step", () => {
    const c1 = makeCase("c1", 100);
    const running = makeStep("c1", "delegate", "active", { sequence: 1, delegation_run_id: "run-1" });
    const c2 = makeCase("c2", 200);
    const pending = makeStep("c2", "delegate", "pending", { sequence: 1 });
    const actions = planTeamPatrol({
      cases: [
        { case: c1, steps: [running] },
        { case: c2, steps: [pending] },
      ],
      findRun: () => runOf("running"),
    });
    expect(actions.filter((a) => a.type === "launch")).toHaveLength(0);
  });

  it("counts active non-implementation work against the team concurrency limit", () => {
    const c1 = makeCase("c1", 100);
    const review = makeStep("c1", "review", "active", { sequence: 1 });
    const c2 = makeCase("c2", 200);
    const pending = makeStep("c2", "implement", "pending", { sequence: 1 });
    const actions = planTeamPatrol({
      cases: [
        { case: c1, steps: [review] },
        { case: c2, steps: [pending] },
      ],
      findRun: () => null,
    });
    expect(actions.filter((a) => a.type === "launch")).toHaveLength(0);
  });

  it("launches after a completed run frees the slot in the same tick", () => {
    const c1 = makeCase("c1", 100);
    const finished = makeStep("c1", "delegate", "active", { sequence: 1, delegation_run_id: "run-1" });
    const next = makeStep("c1", "delegate", "pending", { sequence: 2 });
    const actions = planTeamPatrol({
      cases: [{ case: c1, steps: [finished, next] }],
      findRun: () => runOf("completed"),
    });
    expect(actions).toContainEqual({ type: "advance", caseId: "c1", stepId: finished.id });
    expect(actions).toContainEqual({ type: "launch", caseId: "c1", stepId: next.id });
  });

  it("prefers the oldest case when contended", () => {
    const older = makeCase("c-old", 100);
    const olderStep = makeStep("c-old", "delegate", "pending", { sequence: 1 });
    const newer = makeCase("c-new", 200);
    const newerStep = makeStep("c-new", "delegate", "pending", { sequence: 1 });
    const actions = planTeamPatrol({
      cases: [
        { case: newer, steps: [newerStep] },
        { case: older, steps: [olderStep] },
      ],
      findRun: () => null,
    });
    const launches = actions.filter((a) => a.type === "launch");
    expect(launches).toEqual([{ type: "launch", caseId: "c-old", stepId: olderStep.id }]);
  });

  it("escalates instead of launching when the case run budget is exhausted", () => {
    const c = makeCase("c1");
    const spent = Array.from({ length: 2 }, (_, i) =>
      makeStep("c1", "delegate", "completed", { sequence: i + 1, delegation_run_id: `run-${i}` }));
    const pending = makeStep("c1", "delegate", "pending", { sequence: 3 });
    const actions = planTeamPatrol({
      cases: [{ case: c, steps: [...spent, pending] }],
      findRun: () => null,
      limits: { maxRunsPerCase: 2 },
    });
    expect(actions.filter((a) => a.type === "launch")).toHaveLength(0);
    expect(actions.some((a) => a.type === "escalate" && a.reason === "budget-exhausted")).toBe(true);
  });

  it("caps launches per tick", () => {
    const c1 = makeCase("c1", 100);
    const s1 = makeStep("c1", "delegate", "pending", { sequence: 1 });
    const c2 = makeCase("c2", 200);
    const s2 = makeStep("c2", "delegate", "pending", { sequence: 1 });
    const actions = planTeamPatrol({
      cases: [
        { case: c1, steps: [s1] },
        { case: c2, steps: [s2] },
      ],
      findRun: () => null,
      limits: { maxActivePerTeam: 2, maxLaunchesPerTick: 1 },
    });
    expect(actions.filter((a) => a.type === "launch")).toHaveLength(1);
  });
});

describe("nextExecutableStep", () => {
  it("returns null when the next incomplete step is not launchable", () => {
    const review = makeStep("c1", "review", "pending", { sequence: 1 });
    expect(nextExecutableStep([review])).toBeNull();
  });

  it("skips cancelled steps", () => {
    const cancelled = makeStep("c1", "delegate", "cancelled", { sequence: 1 });
    const pending = makeStep("c1", "implement", "pending", { sequence: 2 });
    expect(nextExecutableStep([cancelled, pending])?.id).toBe(pending.id);
  });
});
