/** @implements spec/feature/task-workflow-v3.md — Actio task sync: migration M1-M6 dry-run (CC-TF-SYNC-06) */

import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyMigrations } from "../../db/schema.js";
import type { SyncMigrationArgs } from "./args.js";
import { runApply, runDryRun, type SyncMigrationHttp } from "./run.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "actio-sync-"));
  dirs.push(dir);
  const dbPath = join(dir, "concordia.db");
  const db = new Database(dbPath);
  applyMigrations(db);
  db.prepare(`INSERT INTO taskflow_task_state(repo_path, task_path, task_slug, status, actio_task_id, memoria_registration_state, updated_at)
    VALUES ('e:/r', 'actio:a', 'a', 'pending', 'a', 'idle', 1)`).run();
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
      ? { entries: [{ code: "LP", project: "Ludellus-Praeforma", teams: [], renamed_from: ["LwP"] }] }
      : url.includes("/api/tasks?") ? { tasks } : { task: tasks.find((task) => url.endsWith(`/${task.id}`)) }),
    patch: vi.fn(async () => ({})),
  };
}

function args(dbPath: string, out: string, overrides: Partial<SyncMigrationArgs> = {}): SyncMigrationArgs {
  return { actioUrl: "http://actio", ccUrl: "http://cc", dbPath, out, renames: [], apply: null, plan: null, ...overrides };
}

describe("actio-sync-migration run", () => {
  it("writes a dry-run plan without any write request", async () => {
    const { dir, dbPath } = workspace();
    const client = http();
    const plan = await runDryRun(args(dbPath, join(dir, "plan.json")), client, new Date("2026-10-12T00:00:00Z"));
    expect(plan.summary).toMatchObject({ M2: { moves: 1 }, M6: { drift: 1 } });
    expect(JSON.parse(readFileSync(join(dir, "plan.json"), "utf8")).generated_at).toBe("2026-10-12T00:00:00.000Z");
    expect(client.patch).not.toHaveBeenCalled();
  });

  it("applies an approved plan through the Actio API and records skipped tasks", async () => {
    const { dir, dbPath } = workspace();
    const planPath = join(dir, "plan.json");
    await runDryRun(args(dbPath, planPath), http(), new Date());
    const client = http([{ ...TASKS[0]!, projectId: "LP" }]);
    const result = await runApply(args(dbPath, join(dir, "result.json"), { apply: new Set(["M2"]), plan: planPath }), client);
    // 計画の後に別の手段で付け替え済み: 前提が崩れたので飛ばす。
    expect(result).toEqual({ applied: 0, skipped: 1, failed: 0 });

    const fresh = http();
    expect(await runApply(args(dbPath, join(dir, "result.json"), { apply: new Set(["M2"]), plan: planPath }), fresh))
      .toEqual({ applied: 1, skipped: 0, failed: 0 });
    expect(fresh.patch).toHaveBeenCalledWith("http://actio/api/tasks/a", { projectId: "LP" });
  });
});
