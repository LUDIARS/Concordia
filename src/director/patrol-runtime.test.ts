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
      // 問診の起動ガード。既定は「未回答なし・停滞なし」= 既存の巡回挙動のまま。
      hasUnansweredAskHumanDecisionsForCase: () => false,
      getStallTicks: () => 0,
      setStallTicks: () => {},
    },
    runs: {
      findRun: () => null,
      findRunByTriggeredBy: () => overrides.runByTrigger ?? null,
      countRunsByTriggeredByLike: () => 0,
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

  // spec/feature/director-inquiry-session.md §1: 従来カードで済ませていた事由は
  // 問診セッションの起動事由へ格上げされた。カードはフォールバックとして残る。
  it("raises an inquiry session instead of a card when the target repo cannot be resolved", async () => {
    const h = makeHarness({ resolveRepo: () => null });
    const patrol = startDirectorPatrol(h.deps);
    await patrol.runOnce();
    patrol.stop();

    expect(h.invoke).toHaveBeenCalledTimes(1);
    const input = h.invoke.mock.calls[0]![0];
    expect(input.triggered_by).toMatch(/^director-inquiry:step-1:repo-unresolved:\d{4}-\d{2}-\d{2}$/);
    expect(input.options).toMatchObject({ team: "team-1", goal_and_go: false });
    // 読むだけなので、リポが解決できなくても target_repo 無しで起動する。
    expect(input.args.target_repo).toBeUndefined();
    expect(h.emit).not.toHaveBeenCalled();
  });

  it("does not start a second inquiry for the same case and reason on the same day", async () => {
    const h = makeHarness({ resolveRepo: () => null });
    const patrol = startDirectorPatrol(h.deps);
    await patrol.runOnce();
    // 1 巡目で起動した run が triggered_by で見つかる状態を作る。走行中の run は
    // それ自身が通知経路なので、カードは重ねない (死んだ run の扱いは
    // inquiry-runtime.test.ts 側で固定する)。
    h.deps.runs.findRunByTriggeredBy = (key: string) =>
      key.startsWith("director-inquiry:") ? { id: "run-inquiry", status: "running" as const } : null;
    await patrol.runOnce();
    patrol.stop();

    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(h.emit).not.toHaveBeenCalled();
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
