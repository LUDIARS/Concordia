/** @implements spec/feature/task-workflow-v3.md — Actio task sync: migration M1-M6 dry-run (CC-TF-SYNC-06) */

import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyMigrations } from "../../db/schema.js";
import type { SyncMigrationArgs } from "./args.js";
import type { LegacyMigrationIo } from "./legacy-ports.js";
import { openLegacyState } from "./legacy-state.js";
import { runApply, runDryRun, type SyncMigrationHttp } from "./run.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const NOW = new Date("2026-10-12T00:00:00Z");

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "actio-sync-"));
  dirs.push(dir);
  const dbPath = join(dir, "concordia.db");
  const db = new Database(dbPath);
  applyMigrations(db);
  const insert = db.prepare(`INSERT INTO taskflow_task_state(repo_path, task_path, task_slug, status, actio_task_id, memoria_registration_state, updated_at)
    VALUES ('e:/r', ?, ?, ?, ?, 'idle', ?)`);
  insert.run("actio:a", "a", "pending", "a", 1);
  insert.run("spec/tasks/recent.md", "recent", "pending", null, Date.parse("2026-10-05T00:00:00Z"));
  insert.run("spec/tasks/finished.md", "finished", "done", null, Date.parse("2026-10-05T00:00:00Z"));
  db.close();
  return { dir, dbPath };
}

const TASKS = [
  { id: "a", title: "t", description: "", projectId: "LwP", teamId: null, status: "done", source: "concordia.taskflow.v3",
    pluginPayload: {}, createdAt: "2026-10-11T00:00:00Z", ownerId: "owner" },
];

function http(tasks = TASKS): SyncMigrationHttp & { patch: ReturnType<typeof vi.fn> } {
  return {
    get: vi.fn(async (url: string) => url.includes("/v1/project-codes/admin")
      ? { entries: [{ code: "LP", project: "Ludellus-Praeforma", teams: [], renamed_from: ["LwP"], repo_path: "e:/r" }] }
      : url.includes("/api/tasks?") ? { tasks } : { task: tasks.find((task) => url.endsWith(`/${task.id}`)) }),
    patch: vi.fn(async () => ({})),
  };
}

function legacyIo(): LegacyMigrationIo & { createTask: ReturnType<typeof vi.fn> } {
  return {
    commitTimes: () => new Map(),
    bindings: async () => [{ repoPath: "e:/r", project: "Ludellus-Praeforma", projectId: "LP", ownerId: "actio-local",
      authMode: "loopback", subsidiaryId: null, teamId: null }],
    readContent: () => ({ title: "旧タスク", body: "本文", kind: "実装", memoryLinks: [] }),
    openState: openLegacyState,
    createTask: vi.fn(async () => ({ id: "new", existed: false })),
  };
}

function args(dbPath: string, out: string, overrides: Partial<SyncMigrationArgs> = {}): SyncMigrationArgs {
  return { actioUrl: "http://actio", ccUrl: "http://cc", dbPath, out, renames: [], apply: null, plan: null, legacyRecentDays: 30, ...overrides };
}

function stateRows(dbPath: string): Array<{ task_path: string; actio_task_id: string | null }> {
  const db = new Database(dbPath, { readonly: true });
  try { return db.prepare("SELECT task_path, actio_task_id FROM taskflow_task_state ORDER BY task_path").all() as never; }
  finally { db.close(); }
}

describe("actio-sync-migration run", () => {
  it("writes a dry-run plan without any write request", async () => {
    const { dir, dbPath } = workspace();
    const client = http();
    const legacy = legacyIo();
    const plan = await runDryRun(args(dbPath, join(dir, "plan.json")), client, NOW, legacy);
    expect(plan.summary).toMatchObject({ M2: { moves: 1 }, M5: { create: 1, archive: 1, unbound: 0 }, M6: { drift: 1 } });
    expect(plan.M5.create[0]).toMatchObject({ task_path: "spec/tasks/recent.md", title: "旧タスク", project: "LP", team: null });
    expect(JSON.parse(readFileSync(join(dir, "plan.json"), "utf8")).generated_at).toBe("2026-10-12T00:00:00.000Z");
    expect(client.patch).not.toHaveBeenCalled();
    expect(legacy.createTask).not.toHaveBeenCalled();
    expect(stateRows(dbPath).map((row) => row.task_path)).toEqual(["actio:a", "spec/tasks/finished.md", "spec/tasks/recent.md"]);
  });

  it("applies an approved plan through the Actio API and records skipped tasks", async () => {
    const { dir, dbPath } = workspace();
    const planPath = join(dir, "plan.json");
    await runDryRun(args(dbPath, planPath), http(), NOW, legacyIo());
    const client = http([{ ...TASKS[0]!, projectId: "LP" }]);
    const result = await runApply(args(dbPath, join(dir, "result.json"), { apply: new Set(["M2"]), plan: planPath }), client, legacyIo());
    // 計画の後に別の手段で付け替え済み: 前提が崩れたので飛ばす。
    expect(result).toEqual({ applied: 0, skipped: 1, failed: 0 });

    const fresh = http();
    expect(await runApply(args(dbPath, join(dir, "result.json"), { apply: new Set(["M2"]), plan: planPath }), fresh, legacyIo()))
      .toEqual({ applied: 1, skipped: 0, failed: 0 });
    expect(fresh.patch).toHaveBeenCalledWith("http://actio/api/tasks/a", { projectId: "LP" });
  });

  it("applies M5 by creating recent md tasks in Actio and archiving the rest in the Cc state", async () => {
    const { dir, dbPath } = workspace();
    const planPath = join(dir, "plan.json");
    await runDryRun(args(dbPath, planPath), http(), NOW, legacyIo());
    const legacy = legacyIo();
    const resultPath = join(dir, "result.json");
    expect(await runApply(args(dbPath, resultPath, { apply: new Set(["M5"]), plan: planPath }), http(), legacy))
      .toEqual({ applied: 2, skipped: 0, failed: 0 });
    expect(legacy.createTask).toHaveBeenCalledTimes(1);
    expect(legacy.createTask.mock.calls[0]![1]).toMatchObject({ source_ref: "work:e:/r:spec/tasks/recent.md", status: "pending" });
    expect(stateRows(dbPath)).toEqual([
      { task_path: "actio:a", actio_task_id: "a" },
      { task_path: "actio:new", actio_task_id: "new" },
      { task_path: "archived:spec/tasks/finished.md", actio_task_id: null },
    ]);

    // 再実行しても行は動かない (計画時の行がもう無い)。
    const again = legacyIo();
    expect(await runApply(args(dbPath, resultPath, { apply: new Set(["M5"]), plan: planPath }), http(), again))
      .toEqual({ applied: 0, skipped: 2, failed: 0 });
    expect(again.createTask).not.toHaveBeenCalled();
  });
});
