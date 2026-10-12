/** @implements spec/feature/task-workflow-v3.md — Actio task sync: migration M1-M6 dry-run (CC-TF-SYNC-06) */

import { describe, expect, it } from "vitest";
import { migrationOperations, operationPatch, parseApplySteps } from "./sync-migration-apply.js";
import { branchByTask, planDuplicateMerges } from "./sync-migration-duplicates.js";
import { planLegacyTasks } from "./sync-migration-legacy.js";
import { categoryTerms, planMemoriaProjects } from "./sync-migration-memoria.js";
import { buildSyncMigrationPlan } from "./sync-migration-plan.js";
import { parseManualRenames, planRenamedCodes } from "./sync-migration-renamed-codes.js";
import { planStatusDrift } from "./sync-migration-status.js";
import { planTeamAssignments } from "./sync-migration-teams.js";
import { V3_SOURCE, type MigrationActioTask, type MigrationProject } from "./sync-migration-types.js";

function task(id: string, overrides: Partial<MigrationActioTask> = {}): MigrationActioTask {
  return { id, title: "実装委託 (Opus 5.5)", description: "", projectId: "Ll", teamId: null, status: "in_progress",
    source: V3_SOURCE, category: null, pluginPayload: {}, createdAt: `2026-10-11T00:00:0${id.length}.000Z`, ...overrides };
}

const PROJECTS: MigrationProject[] = [
  { code: "Ll", project: "Ludellus-Server", teams: [], renamed_from: [] },
  { code: "Cc", project: "Concordia", teams: ["team-cc"], renamed_from: [] },
  { code: "Cr", project: "Cernere", teams: ["a", "b"], renamed_from: [] },
  { code: "LP", project: "Ludellus-Praeforma", teams: [], renamed_from: ["LwP"] },
  { code: "Di", project: "Discutere", teams: [], renamed_from: [] },
];

describe("M1 duplicate merges", () => {
  it("pairs open v3 tasks on the same project and branch, keeping the newest", () => {
    const tasks = [task("old", { createdAt: "2026-10-11T12:24:51Z" }), task("newer", { createdAt: "2026-10-11T13:36:42Z" }),
      task("done", { status: "done" })];
    const runs = [
      { id: "r1", reference: "actio:old", branch: "feat/mmo", createdAt: 1 },
      { id: "r2", reference: "actio:newer", branch: "feat/mmo", createdAt: 2 },
      { id: "r3", reference: "actio:done", branch: "feat/mmo", createdAt: 3 },
    ];
    expect(planDuplicateMerges(tasks, runs)).toEqual([{
      project: "Ll", basis: "branch", key: "Ll / feat/mmo", keep: "actio:newer", supersede: ["actio:old"], review_required: false,
    }]);
  });

  it("marks same-title groups without a known branch for review", () => {
    const groups = planDuplicateMerges([task("a"), task("bb")], []);
    expect(groups).toEqual([expect.objectContaining({ basis: "title", keep: "actio:bb", supersede: ["actio:a"], review_required: true })]);
  });

  it("uses the latest run of a task as its branch", () => {
    expect(branchByTask([
      { id: "r1", reference: "actio:t", branch: "feat/a", createdAt: 1 },
      { id: "r2", reference: "actio:t", branch: "feat/b", createdAt: 2 },
    ])).toEqual(new Map([["t", "feat/b"]]));
  });
});

describe("M2 renamed codes", () => {
  it("moves tasks of a removed code using renamed_from and manual mappings", () => {
    const plan = planRenamedCodes([task("a", { projectId: "LwP" }), task("b", { projectId: "Old" }), task("c", { projectId: "Gone" })],
      PROJECTS, parseManualRenames(["Old=Cc", "Gone=Missing"]));
    expect(plan).toEqual({
      moves: [{ task: "actio:a", from: "LwP", to: "LP" }, { task: "actio:b", from: "Old", to: "Cc" }],
      unresolved: [{ task: "actio:c", project_id: "Gone" }],
    });
    expect(() => parseManualRenames(["broken"])).toThrow("OLD=NEW");
  });
});

describe("M3 team assignments", () => {
  it("assigns the only team and lists multi-team projects for a human choice", () => {
    expect(planTeamAssignments([task("a", { projectId: "Cc" }), task("b", { projectId: "Cr" }),
      task("c", { projectId: "Cc", teamId: "team-cc" }), task("d", { projectId: "Cc", status: "cancelled" })], PROJECTS)).toEqual({
      assign: [{ task: "actio:a", project: "Cc", team: "team-cc" }],
      choose: [{ task: "actio:b", project: "Cr", candidates: ["a", "b"] }],
    });
  });
});

describe("M4 Memoria projects", () => {
  it("matches category terms to a code or project name exactly and leaves the rest to people", () => {
    const memoria = (id: string, category: string, status: MigrationActioTask["status"] = "open") =>
      task(id, { projectId: null, source: "memoria-import", category, status });
    expect(categoryTerms("Concordia, 確認作業")).toEqual(["Concordia", "確認作業"]);
    expect(planMemoriaProjects([memoria("a", "Concordia, 確認作業"), memoria("b", "Di開発"), memoria("c", "Cc、Cr"),
      memoria("d", "Cc", "done")], PROJECTS)).toEqual({
      assign: [{ task: "actio:a", project: "Cc", matched: "Concordia" }],
      unresolved: [{ task: "actio:b", category: "Di開発", candidates: [] }, { task: "actio:c", category: "Cc、Cr", candidates: ["Cc", "Cr"] }],
    });
  });
});

describe("M5 legacy md tasks", () => {
  it("creates only recent pending and delegated md tasks by work key and lists the rest for archive", () => {
    const repo = "e:/document/ars/concordia";
    const now = new Date("2026-10-12T00:00:00Z");
    const recent = Date.parse("2026-10-01T00:00:00Z");
    const old = Date.parse("2026-08-01T00:00:00Z");
    expect(planLegacyTasks([
      { repo_path: repo, task_path: "spec\\tasks\\a.md", status: "pending", actio_task_id: null, delegation_run_id: null, updated_at: recent },
      { repo_path: repo, task_path: "spec/tasks/b.md", status: "done", actio_task_id: null, delegation_run_id: null, updated_at: recent },
      { repo_path: repo, task_path: "spec/tasks/c.md", status: "delegated", actio_task_id: null, delegation_run_id: null, updated_at: 0 },
      { repo_path: repo, task_path: "spec/tasks/d.md", status: "pending", actio_task_id: null, delegation_run_id: null, updated_at: old },
      { repo_path: repo, task_path: "spec/tasks/e.md", status: "pending", actio_task_id: null, delegation_run_id: null, updated_at: 0 },
      { repo_path: repo, task_path: "actio:x", status: "pending", actio_task_id: "x", delegation_run_id: null },
    ], { now, commitTimes: new Map([[`${repo}\0spec/tasks/c.md`, recent]]) })).toEqual({
      recent_days: 30, recent_since: "2026-09-12T00:00:00.000Z",
      create: [
        { repo_path: repo, task_path: "spec/tasks/a.md", status: "pending", source_ref: `work:${repo}:spec/tasks/a.md`,
          subsidiary_id: null, activity_at: "2026-10-01T00:00:00.000Z", activity_basis: "state" },
        { repo_path: repo, task_path: "spec/tasks/c.md", status: "delegated", source_ref: `work:${repo}:spec/tasks/c.md`,
          subsidiary_id: null, activity_at: "2026-10-01T00:00:00.000Z", activity_basis: "git" },
      ],
      archive: [
        { repo_path: repo, task_path: "spec/tasks/b.md", status: "done", reason: "closed", activity_at: "2026-10-01T00:00:00.000Z" },
        { repo_path: repo, task_path: "spec/tasks/d.md", status: "pending", reason: "inactive", activity_at: "2026-08-01T00:00:00.000Z" },
        { repo_path: repo, task_path: "spec/tasks/e.md", status: "pending", reason: "no_activity", activity_at: null },
      ],
      unbound: [],
    });
  });

  it("takes the recent window in days from the caller", () => {
    const rows = [{ repo_path: "r", task_path: "spec/tasks/d.md", status: "pending", actio_task_id: null, delegation_run_id: null,
      updated_at: Date.parse("2026-08-01T00:00:00Z") }];
    expect(planLegacyTasks(rows, { now: new Date("2026-10-12T00:00:00Z"), recentDays: 90 }).create).toHaveLength(1);
  });
});

describe("M6 status drift", () => {
  it("compares the Cc cache with Actio and reports references missing in Actio", () => {
    expect(planStatusDrift([
      { repo_path: "r", task_path: "actio:a", status: "pending", actio_task_id: "a", delegation_run_id: null },
      { repo_path: "r", task_path: "actio:b", status: "delegated", actio_task_id: "b", delegation_run_id: null },
      { repo_path: "r", task_path: "actio:z", status: "pending", actio_task_id: "z", delegation_run_id: null },
    ], [task("a", { status: "done" }), task("b", { status: "in_progress" })])).toEqual({
      drift: [{ reference: "actio:a", repo_path: "r", cc: "pending", actio: "done" }], missing_in_actio: ["actio:z"],
    });
  });
});

describe("plan and apply", () => {
  const plan = buildSyncMigrationPlan({
    tasks: [task("old"), task("new1"), task("t", { projectId: "Cc" }), task("m", { projectId: "LwP" })],
    projects: PROJECTS, stateRows: [],
    runs: [{ id: "r1", reference: "actio:old", branch: "feat/x", createdAt: 1 }, { id: "r2", reference: "actio:new1", branch: "feat/x", createdAt: 2 }],
    manualRenames: new Map(), generatedAt: "2026-10-12T00:00:00.000Z",
  });

  it("summarizes every step as a dry run", () => {
    expect(plan.dry_run).toBe(true);
    expect(plan.summary).toMatchObject({ M1: { groups: 1, superseded_tasks: 1 }, M2: { moves: 1 }, M3: { assign: 1 } });
  });

  it("turns only the approved steps into Actio operations", () => {
    expect(migrationOperations(plan, parseApplySteps("M1,M3"))).toEqual([
      { step: "M1", task: "actio:old", op: "supersede", superseded_by: "actio:new1" },
      { step: "M3", task: "actio:t", op: "set_team", team: "team-cc" },
    ]);
    // M5 は PATCH ではなく sync-migration-legacy-apply.ts が適用する。
    expect(migrationOperations(plan, parseApplySteps("M5"))).toEqual([]);
    expect(() => parseApplySteps("M6")).toThrow("unsupported apply step");
  });

  it("builds the patch from the current task and skips when the plan's premise changed", () => {
    expect(operationPatch({ step: "M1", task: "actio:old", op: "supersede", superseded_by: "actio:new1" }, task("old", { pluginPayload: { kind: "実装" } })))
      .toEqual({ status: "cancelled", pluginPayload: { kind: "実装", superseded_by: "actio:new1" } });
    expect(operationPatch({ step: "M1", task: "actio:old", op: "supersede", superseded_by: "actio:new1" }, task("old", { status: "done" }))).toBeNull();
    expect(operationPatch({ step: "M2", task: "actio:m", op: "set_project", project: "LP", expected_project: "LwP" }, task("m", { projectId: "Cc" }))).toBeNull();
    expect(operationPatch({ step: "M3", task: "actio:t", op: "set_team", team: "team-cc" }, { ...task("t"), ownerId: "owner", assigneeId: null }))
      .toEqual({ teamId: "team-cc", assigneeId: "owner" });
  });
});
