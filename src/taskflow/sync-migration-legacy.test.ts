/** @implements spec/feature/task-workflow-v3.md — Actio task sync: migration M5 legacy md tasks (CC-TF-SYNC-06) */

import { describe, expect, it, vi } from "vitest";
import type { ActioBinding } from "./actio-binding.js";
import { applyLegacyPlan, archivedTaskPath, type LegacyApplyPorts } from "./sync-migration-legacy-apply.js";
import { bindingForRepo, describeLegacyPlan } from "./sync-migration-legacy-describe.js";
import { legacyActivity, legacyRowKey } from "./sync-migration-legacy-recency.js";
import type { LegacyCreatePlan, LegacyTaskPlan } from "./sync-migration-legacy.js";
import type { MigrationStateRow } from "./sync-migration-types.js";

const REPO = "e:/document/ars/concordia";

function binding(overrides: Partial<ActioBinding> = {}): ActioBinding {
  return { repoPath: "E:\\Document\\Ars\\Concordia", project: "Concordia", projectId: "Cc", ownerId: "actio-local",
    authMode: "loopback", subsidiaryId: null, teamId: "team-cc", ...overrides };
}

function createEntry(overrides: Partial<LegacyCreatePlan> = {}): LegacyCreatePlan {
  return { repo_path: REPO, task_path: "spec/tasks/a.md", status: "pending", source_ref: `work:${REPO}:spec/tasks/a.md`,
    subsidiary_id: null, activity_at: "2026-10-01T00:00:00.000Z", activity_basis: "state", ...overrides };
}

function row(taskPath: string, overrides: Partial<MigrationStateRow> = {}): MigrationStateRow {
  return { repo_path: REPO, task_path: taskPath, status: "pending", actio_task_id: null, delegation_run_id: null, ...overrides };
}

function plan(overrides: Partial<LegacyTaskPlan> = {}): LegacyTaskPlan {
  return { recent_days: 30, recent_since: "2026-09-12T00:00:00.000Z", create: [], archive: [], unbound: [], ...overrides };
}

describe("M5 recency", () => {
  it("prefers the state row's update time and falls back to the md file's last commit", () => {
    expect(legacyActivity(row("spec/tasks/a.md", { updated_at: 5 }), new Map([[legacyRowKey(REPO, "spec/tasks/a.md"), 9]])))
      .toEqual({ at: 5, basis: "state" });
    expect(legacyActivity(row("spec\\tasks\\a.md", { updated_at: 0 }), new Map([[legacyRowKey(REPO, "spec/tasks/a.md"), 9]])))
      .toEqual({ at: 9, basis: "git" });
    expect(legacyActivity(row("spec/tasks/a.md"), new Map())).toBeNull();
  });
});

describe("M5 describe", () => {
  it("uses the repository's head-office Actio binding and the md title", () => {
    const described = describeLegacyPlan(plan({ create: [createEntry()] }), [binding()],
      () => ({ title: "旧タスク", body: "本文", kind: "実装", memoryLinks: [] }));
    expect(described.create).toEqual([{ ...createEntry(), title: "旧タスク", project: "Cc", team: "team-cc" }]);
    expect(described.unbound).toEqual([]);
  });

  it("leaves tasks without a binding, a readable md or on a subsidiary for people", () => {
    const entries = [createEntry(), createEntry({ task_path: "spec/tasks/b.md", repo_path: "e:/other" }),
      createEntry({ task_path: "spec/tasks/c.md", subsidiary_id: "sub" })];
    const described = describeLegacyPlan(plan({ create: entries }), [binding()], () => null);
    expect(described.create).toEqual([]);
    expect(described.unbound.map((item) => item.reason)).toEqual(["md_missing", "no_actio_binding", "subsidiary_task"]);
  });

  it("refuses to choose between two bindings of one repository", () => {
    expect(bindingForRepo([binding(), binding({ projectId: "Cx" })], REPO, null)).toEqual({ ok: false, reason: "ambiguous_actio_binding" });
  });
});

describe("M5 apply", () => {
  function ports(rows: MigrationStateRow[], created: { id: string; existed: boolean } | { skip: string } = { id: "t1", existed: false }) {
    const table = new Map(rows.map((item) => [item.task_path, item]));
    return {
      currentRow: vi.fn((_repo: string, path: string) => table.get(path) ?? null),
      createTask: vi.fn(async () => created),
      replaceTaskPath: vi.fn((_repo: string, from: string, to: string) => {
        if (table.has(to) || !table.has(from)) return false;
        table.set(to, table.get(from)!); table.delete(from); return true;
      }),
    } satisfies LegacyApplyPorts;
  }

  it("creates the task once and points the state row at the Actio reference", async () => {
    const io = ports([row("spec/tasks/a.md")]);
    const results = await applyLegacyPlan(plan({ create: [createEntry({ title: "t", project: "Cc", team: "team-cc" })] }), io);
    expect(results).toEqual([{ step: "M5", task: `${REPO}:spec/tasks/a.md`, op: "create", result: "applied", reference: "actio:t1", existed: false }]);
    expect(io.replaceTaskPath).toHaveBeenCalledWith(REPO, "spec/tasks/a.md", "actio:t1", "t1");
  });

  it("archives by moving the row out of the legacy and Actio namespaces", async () => {
    const io = ports([row("spec/tasks/b.md", { status: "done" })]);
    const results = await applyLegacyPlan(plan({
      archive: [{ repo_path: REPO, task_path: "spec/tasks/b.md", status: "done", reason: "closed", activity_at: null }],
    }), io);
    expect(results[0]).toMatchObject({ op: "archive", result: "applied", reference: archivedTaskPath("spec/tasks/b.md") });
    expect(io.replaceTaskPath).toHaveBeenCalledWith(REPO, "spec/tasks/b.md", "archived:spec/tasks/b.md", null);
  });

  it("skips rows whose premise changed or that were not described, and records failures", async () => {
    const described = createEntry({ title: "t", project: "Cc", team: null });
    const changed = ports([row("spec/tasks/a.md", { status: "done" })]);
    expect((await applyLegacyPlan(plan({ create: [described] }), changed))[0]).toMatchObject({ result: "skipped", note: "state_changed" });
    expect(changed.createTask).not.toHaveBeenCalled();
    expect((await applyLegacyPlan(plan({ create: [createEntry()] }), ports([row("spec/tasks/a.md")])))[0])
      .toMatchObject({ result: "skipped", note: "not_described" });
    expect((await applyLegacyPlan(plan({ create: [described] }), ports([row("spec/tasks/a.md")], { skip: "binding_changed" }))))
      .toMatchObject([{ result: "skipped", note: "binding_changed" }]);
    const occupied = ports([row("spec/tasks/a.md"), row("actio:t1", { actio_task_id: "t1" })], { id: "t1", existed: true });
    expect((await applyLegacyPlan(plan({ create: [described] }), occupied))[0])
      .toMatchObject({ result: "skipped", reference: "actio:t1", existed: true, note: "reference_row_exists" });
    const failing = ports([row("spec/tasks/a.md")]);
    failing.createTask.mockRejectedValueOnce(new Error("Actio task service unavailable"));
    expect((await applyLegacyPlan(plan({ create: [described] }), failing))[0])
      .toMatchObject({ result: "failed", error: "Actio task service unavailable" });
  });
});
