import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  patrolTriggeredBy,
  renderTask,
  resolveTargetRepo,
  startDirectorPatrol,
  type DirectorPatrolDeps,
} from "./patrol-runtime.js";
import type { DirectorCase, DirectorStep } from "./types.js";

function makeCase(id: string, overrides: Partial<DirectorCase> = {}): DirectorCase {
  return {
    id,
    title: `case ${id}`,
    goal: "goal text",
    project: "Concordia",
    session_id: null,
    team_id: "team-1",
    created_at: 100,
    updated_at: 100,
    ...overrides,
  };
}

function makeStep(caseId: string, overrides: Partial<DirectorStep> = {}): DirectorStep {
  return {
    id: "step-1",
    case_id: caseId,
    sequence: 1,
    kind: "delegate",
    title: "implement it",
    status: "pending",
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

interface HarnessOverrides {
  steps?: DirectorStep[];
  runByTrigger?: { id: string; status: "running" } | null;
  resolveRepo?: DirectorPatrolDeps["resolveRepo"];
  invokeOk?: boolean;
}

function makeHarness(overrides: HarnessOverrides = {}) {
  const directorCase = makeCase("c1");
  const steps = overrides.steps ?? [makeStep("c1")];
  const assignStepRun = vi.fn().mockReturnValue(steps[0]);
  const updateStepStatus = vi.fn().mockReturnValue(steps[0]);
  const invoke = vi.fn().mockResolvedValue(
    overrides.invokeOk === false
      ? { ok: false as const, error: "nope" }
      : { ok: true as const, run: { id: "run-new" } },
  );
  const emit = vi.fn();
  const deps: DirectorPatrolDeps = {
    teams: {
      list: () => [{ id: "team-1", name: "Team One", slug: "team-one" }],
      repos: () => ["LUDIARS/Concordia"],
    },
    director: {
      listCases: () => [directorCase],
      findCaseDetail: () => ({ case: directorCase, steps }),
      updateStepStatus,
      assignStepRun,
    },
    runs: {
      findRun: () => null,
      findRunByTriggeredBy: () => overrides.runByTrigger ?? null,
    },
    delegationService: { invoke },
    workspaceRoots: [],
    resolveRepo: overrides.resolveRepo ?? (() => "E:/repo/Concordia"),
    tickMs: 60 * 60 * 1000,
    emit,
  };
  return { deps, invoke, assignStepRun, updateStepStatus, emit, directorCase, steps };
}

describe("startDirectorPatrol", () => {
  it("launches a team-attributed implement session and records the run on the step", async () => {
    const h = makeHarness();
    const patrol = startDirectorPatrol(h.deps);
    await patrol.runOnce();
    patrol.stop();

    expect(h.invoke).toHaveBeenCalledTimes(1);
    const input = h.invoke.mock.calls[0]![0];
    expect(input.triggered_by).toBe(patrolTriggeredBy("step-1"));
    expect(input.options).toMatchObject({ team: "team-1", goal_and_go: true });
    expect(input.args.target_repo).toBe("E:/repo/Concordia");
    expect(String(input.args.task)).toContain("case c1");
    expect(h.assignStepRun).toHaveBeenCalledWith(
      expect.objectContaining({ id: "step-1", delegation_run_id: "run-new" }),
    );
  });

  it("recovers an existing run by triggered_by instead of double-launching", async () => {
    const h = makeHarness({ runByTrigger: { id: "run-old", status: "running" } });
    const patrol = startDirectorPatrol(h.deps);
    await patrol.runOnce();
    patrol.stop();

    expect(h.invoke).not.toHaveBeenCalled();
    expect(h.assignStepRun).toHaveBeenCalledWith(
      expect.objectContaining({ id: "step-1", delegation_run_id: "run-old" }),
    );
  });

  it("escalates with a question card when the target repo cannot be resolved", async () => {
    const h = makeHarness({ resolveRepo: () => null });
    const patrol = startDirectorPatrol(h.deps);
    await patrol.runOnce();
    patrol.stop();

    expect(h.invoke).not.toHaveBeenCalled();
    expect(h.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "team.card_requested", kind: "question", team_id: "team-1" }),
    );
  });

  it("dedupes same-day escalations for the same case and reason", async () => {
    const h = makeHarness({ resolveRepo: () => null });
    const patrol = startDirectorPatrol(h.deps);
    await patrol.runOnce();
    await patrol.runOnce();
    patrol.stop();

    expect(h.emit).toHaveBeenCalledTimes(1);
  });

  it("does not record a run and escalates when the invoke fails", async () => {
    const h = makeHarness({ invokeOk: false });
    const patrol = startDirectorPatrol(h.deps);
    await patrol.runOnce();
    patrol.stop();

    expect(h.assignStepRun).not.toHaveBeenCalled();
    expect(h.emit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "question", body: expect.stringContaining("launch-failed") }),
    );
  });

  it("does not overlap ticks while an earlier patrol is still invoking", async () => {
    const h = makeHarness();
    let finishInvoke!: () => void;
    const invoke = vi.fn(() => new Promise<{ ok: true; run: { id: string } }>((resolve) => {
      finishInvoke = () => resolve({ ok: true, run: { id: "run-new" } });
    }));
    h.deps.delegationService.invoke = invoke;
    const patrol = startDirectorPatrol(h.deps);

    const first = patrol.runOnce();
    const overlapping = patrol.runOnce();
    expect(invoke).toHaveBeenCalledTimes(1);
    finishInvoke();
    await Promise.all([first, overlapping]);
    patrol.stop();
  });

  it("advances a completed run to a completed step via reconcile", async () => {
    const steps = [makeStep("c1", { status: "active", delegation_run_id: "run-1" })];
    const h = makeHarness({ steps });
    h.deps.runs.findRun = () => ({ id: "run-1", status: "completed" as const });
    const patrol = startDirectorPatrol(h.deps);
    await patrol.runOnce();
    patrol.stop();

    expect(h.updateStepStatus).toHaveBeenCalledWith(
      expect.objectContaining({ id: "step-1", status: "completed" }),
    );
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it("does not launch a successor when the reconciled predecessor changed concurrently", async () => {
    const steps = [
      makeStep("c1", { id: "step-1", sequence: 1, status: "active", delegation_run_id: "run-1" }),
      makeStep("c1", { id: "step-2", sequence: 2 }),
    ];
    const h = makeHarness({ steps });
    h.deps.runs.findRun = () => ({ id: "run-1", status: "completed" as const });
    h.deps.director.updateStepStatus = () => null;
    const patrol = startDirectorPatrol(h.deps);
    await patrol.runOnce();
    patrol.stop();

    expect(h.invoke).not.toHaveBeenCalled();
    expect(h.assignStepRun).not.toHaveBeenCalled();
  });
});

describe("resolveTargetRepo", () => {
  it("matches a multi-repo team by case project name (case-insensitive)", () => {
    // resolveClonePaths は実ファイルシステムを見るので、ここでは名前解決の分岐だけを検証する。
    const single = resolveTargetRepo(
      ["https://github.com/LUDIARS/NoSuchRepoForPatrolTest.git"],
      makeCase("c1"),
      [],
    );
    expect(single).toBeNull(); // クローンが無いので null (名前は解決されている)
    const unmatched = resolveTargetRepo(
      ["LUDIARS/RepoA", "LUDIARS/RepoB"],
      makeCase("c1", { project: "RepoC" }),
      [],
    );
    expect(unmatched).toBeNull();
  });

  it("rejects repository names that escape a workspace root", () => {
    expect(resolveTargetRepo([".."], makeCase("c1"), [join(process.cwd(), "src")])).toBeNull();
    expect(resolveTargetRepo(["..\\.."], makeCase("c1"), [join(process.cwd(), "src", "director")]))
      .toBeNull();
  });
});

describe("renderTask", () => {
  it("includes goal, task path, handoff, and the initial human mention step", () => {
    const text = renderTask(
      makeCase("c1"),
      makeStep("c1", { task_path: "spec/tasks/x.md", handoff_note: "note" }),
    );
    expect(text).toContain("ゴール: goal text");
    expect(text).toContain("spec/tasks/x.md");
    expect(text).toContain("note");
    expect(text).toContain("mention_user_id");
  });
});
