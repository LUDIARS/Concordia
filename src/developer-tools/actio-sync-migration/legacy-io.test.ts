/** @implements spec/feature/task-workflow-v3.md — Actio task sync: migration M5 legacy md tasks (CC-TF-SYNC-06) */

import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyMigrations } from "../../db/schema.js";
import type { ActioBinding } from "../../taskflow/actio-binding.js";
import { legacyCommitTimes } from "./legacy-activity.js";
import { legacyTaskCreator, migrationActioTransport } from "./legacy-actio.js";
import { legacyTaskContent, readLegacyTaskContent } from "./legacy-documents.js";
import { createLegacyMigrationIo } from "./legacy-io.js";
import { legacyApplyPorts, type LegacyMigrationIo } from "./legacy-ports.js";
import { openLegacyState } from "./legacy-state.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "actio-sync-legacy-"));
  dirs.push(dir);
  return dir;
}

const BINDING: ActioBinding = { repoPath: "e:/r", project: "R", projectId: "LP", ownerId: "actio-local",
  authMode: "loopback", subsidiaryId: null, teamId: null };

describe("legacy md content", () => {
  it("takes the title by the delegation title rule and keeps kind and memory links", () => {
    const content = legacyTaskContent("---\ntask: old-slug\nproject: Concordia\nkind: 調査\ncreated: 2026-08-01\nmemory_links: [\"m1\"]\n---\n# 旧タスクの見出し。続きの文\n\n本文\n", "spec/tasks/old.md");
    expect(content).toEqual({ title: "旧タスクの見出し。", body: "# 旧タスクの見出し。続きの文\n\n本文\n", kind: "調査", memoryLinks: ["m1"] });
  });

  it("falls back to the first line without frontmatter and to null when the file is gone", () => {
    expect(legacyTaskContent("やること\n詳細", "spec/tasks/x.md")).toMatchObject({ title: "やること", kind: "実装", memoryLinks: [] });
    expect(legacyTaskContent("---\ntask: only-slug\n---\n本文の行\n", "spec/tasks/y.md")).toEqual({
      title: "本文の行", body: "本文の行\n", kind: "実装", memoryLinks: [] });
    const repo = tempDir();
    mkdirSync(join(repo, "spec", "tasks"), { recursive: true });
    writeFileSync(join(repo, "spec", "tasks", "a.md"), "見出し\n", "utf8");
    expect(readLegacyTaskContent(repo, "spec/tasks/a.md")?.title).toBe("見出し");
    expect(readLegacyTaskContent(repo, "spec/tasks/missing.md")).toBeNull();
  });
});

describe("legacy git activity", () => {
  it("reads the last commit only for legacy rows without a state update time", () => {
    const read = vi.fn((_repo: string, path: string) => path.endsWith("a.md") ? "1760000000\n" : path.endsWith("b.md") ? "" : "x");
    const times = legacyCommitTimes([
      { repo_path: "e:/r", task_path: "spec\\tasks\\a.md", status: "pending", actio_task_id: null, delegation_run_id: null, updated_at: 0 },
      { repo_path: "e:/r", task_path: "spec/tasks/b.md", status: "pending", actio_task_id: null, delegation_run_id: null },
      { repo_path: "e:/r", task_path: "spec/tasks/c.md", status: "pending", actio_task_id: null, delegation_run_id: null, updated_at: 5 },
      { repo_path: "e:/r", task_path: "actio:x", status: "pending", actio_task_id: "x", delegation_run_id: null },
    ], read);
    expect([...times]).toEqual([["e:/r\0spec/tasks/a.md", 1_760_000_000_000]]);
    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledWith("e:/r", "spec/tasks/a.md");
  });

  it("treats a failing git read as unknown", () => {
    expect(legacyCommitTimes([{ repo_path: "e:/r", task_path: "spec/tasks/a.md", status: "pending", actio_task_id: null,
      delegation_run_id: null }], () => { throw new Error("not a git repository"); }).size).toBe(0);
  });
});

describe("legacy Actio access", () => {
  it("only talks to a loopback Actio with an explicit port", () => {
    expect(() => migrationActioTransport("http://actio.example:4000", {})).toThrow("loopback");
    expect(() => migrationActioTransport("http://127.0.0.1", {})).toThrow("explicit port");
    expect(migrationActioTransport("http://127.0.0.1:4000", {})).toBeDefined();
  });

  it("verifies the local identity before creating through the shared client", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method} ${String(url)}`);
      const path = new URL(String(url)).pathname;
      const body = path === "/api/auth/me" ? { id: "actio-local", localMode: true, access: "loopback" }
        : init?.method === "GET" ? { tasks: [] }
        : { task: { id: "t1", title: "旧タスク", description: "本文", projectId: "LP", ownerId: "actio-local", teamId: null,
          status: "open", source: "concordia.taskflow.v3", sourceRef: JSON.parse(String(init?.body)).sourceRef,
          pluginId: "concordia.taskflow.v3", pluginPayload: JSON.parse(String(init?.body)).pluginPayload, createdAt: "2026-10-12T00:00:00Z" } };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const io = createLegacyMigrationIo("http://127.0.0.1:4000", {});
    expect(io).toBeDefined();
    const { ActioWorkflowClient } = await import("../../taskflow/actio-task-client.js");
    const create = legacyTaskCreator(new ActioWorkflowClient(migrationActioTransport("http://127.0.0.1:4000", {}, fetchImpl)));
    const entry = { repo_path: "e:/r", task_path: "spec/tasks/a.md", status: "pending", source_ref: "work:e:/r:spec/tasks/a.md",
      subsidiary_id: null, activity_at: "2026-10-01T00:00:00.000Z", activity_basis: "state" as const, title: "旧タスク", project: "LP", team: null };
    expect(await create(BINDING, entry, { title: "旧タスク", body: "本文", kind: "実装", memoryLinks: [] })).toEqual({ id: "t1", existed: false });
    expect(calls.filter((call) => call.startsWith("POST"))).toEqual(["POST http://127.0.0.1:4000/api/tasks"]);
    expect(calls[0]).toBe("GET http://127.0.0.1:4000/api/auth/me");
  });
});

describe("legacy state rows", () => {
  function database(): string {
    const dbPath = join(tempDir(), "concordia.db");
    const db = new Database(dbPath);
    applyMigrations(db);
    const insert = db.prepare(`INSERT INTO taskflow_task_state(repo_path, task_path, task_slug, status, actio_task_id, memoria_registration_state, updated_at)
      VALUES ('e:/r', ?, ?, 'pending', ?, 'idle', 0)`);
    insert.run("spec\\tasks\\a.md", "a", null);
    insert.run("spec/tasks/b.md", "b", null);
    insert.run("actio:t2", "t2", "t2");
    db.close();
    return dbPath;
  }

  it("replaces only the reference of an unbound legacy row and never overwrites an existing reference", () => {
    const state = openLegacyState(database());
    try {
      expect(state.currentRow("e:/r", "spec/tasks/a.md")?.task_path).toBe("spec\\tasks\\a.md");
      expect(state.replaceTaskPath("e:/r", "spec/tasks/a.md", "actio:t1", "t1")).toBe(true);
      expect(state.currentRow("e:/r", "actio:t1")).toMatchObject({ actio_task_id: "t1", status: "pending" });
      expect(state.replaceTaskPath("e:/r", "spec/tasks/b.md", "actio:t2", "t2")).toBe(false);
      expect(state.replaceTaskPath("e:/r", "spec/tasks/b.md", "archived:spec/tasks/b.md", null)).toBe(true);
      expect(state.currentRow("e:/r", "archived:spec/tasks/b.md")?.actio_task_id).toBeNull();
      expect(state.replaceTaskPath("e:/r", "spec/tasks/missing.md", "archived:x", null)).toBe(false);
    } finally { state.close(); }
  });

  it("re-reads the binding at apply time and refuses a changed destination", async () => {
    const io: LegacyMigrationIo = {
      commitTimes: () => new Map(), bindings: async () => [BINDING], openState: openLegacyState,
      readContent: () => ({ title: "t", body: "b", kind: "実装", memoryLinks: [] }),
      createTask: vi.fn(async () => ({ id: "t1", existed: true })),
    };
    const state = openLegacyState(database());
    try {
      const ports = legacyApplyPorts(io, [BINDING], state);
      const entry = { repo_path: "e:/r", task_path: "spec/tasks/a.md", status: "pending", source_ref: "work:e:/r:spec/tasks/a.md",
        subsidiary_id: null, activity_at: "2026-10-01T00:00:00.000Z", activity_basis: "state" as const, title: "t", project: "LP", team: null };
      expect(await ports.createTask(entry)).toEqual({ id: "t1", existed: true });
      expect(await ports.createTask({ ...entry, project: "Cc" })).toEqual({ skip: "binding_changed" });
      expect(await ports.createTask({ ...entry, repo_path: "e:/other" })).toEqual({ skip: "no_actio_binding" });
    } finally { state.close(); }
  });
});
