/** @implements spec/feature/task-workflow.md — 2.2 登録 (reconcile) */

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "../db/schema.js";
import type { TaskDocument } from "./md-store.js";
import { TaskflowStateStore } from "./state-store.js";

describe("TaskflowStateStore", () => {
  it("migrates legacy runtime frontmatter once without modifying the document", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const store = new TaskflowStateStore(db);
    const document = task({
      status: "delegated",
      source_session: "session-1",
      assignee: "neco",
      owner: "owner",
      delegation_run_id: "run-1",
      pr_number: "324",
      memoria_task_id: 797,
      actio_task_id: "actio-1",
    });

    expect(store.readOrMigrate(document)).toMatchObject({
      status: "delegated",
      source_session: "session-1",
      assignee: "neco",
      owner: "owner",
      delegation_run_id: "run-1",
      pr_number: 324,
      memoria_task_id: "797",
      actio_task_id: "actio-1",
      memoria_registration_state: "created",
    });
    expect(document.frontmatter).toMatchObject({ status: "delegated", memoria_task_id: 797 });

    document.frontmatter.status = "cancelled";
    document.frontmatter.assignee = "changed";
    expect(store.readOrMigrate(document)).toMatchObject({ status: "delegated", assignee: "neco" });
  });

  it("durably claims registration and only records an ID while the claim is active", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const store = new TaskflowStateStore(db, () => 123);
    const document = task({});

    expect(store.claimMemoriaCreation(document)).toBe(true);
    expect(store.claimMemoriaCreation(document)).toBe(false);
    store.recordMemoriaTaskId(document, 42);
    expect(store.readOrMigrate(document)).toMatchObject({ memoria_task_id: "42", memoria_registration_state: "created" });
    expect(db.prepare("SELECT updated_at FROM taskflow_task_state").get()).toEqual({ updated_at: 123 });
    expect(() => store.recordMemoriaTaskId(document, 43)).toThrow("claim is not active");
  });

  it("rejects non-positive and unsafe numeric Memoria IDs without consuming the claim", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const store = new TaskflowStateStore(db);
    const document = task({});

    expect(store.claimMemoriaCreation(document)).toBe(true);
    expect(() => store.recordMemoriaTaskId(document, -1)).toThrow("positive integer");
    expect(() => store.recordMemoriaTaskId(document, Number.MAX_SAFE_INTEGER + 1)).toThrow("positive integer");
    store.recordMemoriaTaskId(document, 42);
  });

  it("releases a definitely failed registration for a later retry", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const store = new TaskflowStateStore(db);
    const document = task({});

    expect(store.claimMemoriaCreation(document)).toBe(true);
    store.releaseMemoriaCreation(document);
    expect(store.readOrMigrate(document)).toMatchObject({ memoria_task_id: null, memoria_registration_state: "idle" });
    expect(store.claimMemoriaCreation(document)).toBe(true);
  });

  it("rejects invalid legacy status and paths outside the repository", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const store = new TaskflowStateStore(db);

    expect(() => store.readOrMigrate(task({ status: "paused" }))).toThrow("legacy task status is invalid");
    expect(() => store.readOrMigrate({
      ...task({}),
      path: "E:/outside/task.md",
    })).toThrow("inside its repository");
  });
  it("moves the task through its lifecycle instead of freezing it at migration", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const store = new TaskflowStateStore(db);
    const document = task({});
    store.readOrMigrate(document);
    const key = { repoPath: "E:/repo", taskPath: "spec/tasks/task.md" };

    expect(store.update(key, { status: "delegated", delegation_run_id: "run-1" })).toBe(true);
    expect(store.readOrMigrate(document)).toMatchObject({ status: "delegated", delegation_run_id: "run-1" });
    expect(store.update(key, { status: "done", pr_number: 12 })).toBe(true);
    expect(store.find(key)).toMatchObject({ status: "done", pr_number: 12, delegation_run_id: "run-1" });
    // 明示 null は消去、 未指定は据え置き。
    expect(store.update(key, { delegation_run_id: null })).toBe(true);
    expect(store.find(key)).toMatchObject({ status: "done", delegation_run_id: null });
  });

  it("reports a miss instead of creating a row for an unknown task", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const store = new TaskflowStateStore(db);
    expect(store.update({ repoPath: "E:/repo", taskPath: "spec/tasks/missing.md" }, { status: "done" })).toBe(false);
    expect(store.find({ repoPath: "E:/repo", taskPath: "spec/tasks/missing.md" })).toBeNull();
  });

  it("carries state across a rename so Memoria is not registered twice", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const store = new TaskflowStateStore(db);
    const before = task({});
    store.readOrMigrate(before);
    store.claimMemoriaCreation(before);
    store.recordMemoriaTaskId(before, 42);
    store.update({ repoPath: "E:/repo", taskPath: "spec/tasks/task.md" }, { status: "delegated" });

    const renamed: TaskDocument = { ...before, path: "E:/repo/spec/tasks/2026-08-08-task.md" };
    expect(store.readOrMigrate(renamed)).toMatchObject({
      status: "delegated", memoria_task_id: "42", memoria_registration_state: "created",
    });
    // 移動元の行は残さない (孤児行が二重登録の種になる)。
    expect(store.find({ repoPath: "E:/repo", taskPath: "spec/tasks/task.md" })).toBeNull();
    expect(store.claimMemoriaCreation(renamed)).toBe(false);
  });

  it("does not guess when two tasks in a repo share a slug", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const store = new TaskflowStateStore(db);
    const first = task({});
    const second: TaskDocument = { ...first, path: "E:/repo/spec/tasks/task-2.md" };
    store.readOrMigrate(first);
    store.readOrMigrate(second);
    store.claimMemoriaCreation(first);
    store.recordMemoriaTaskId(first, 1);

    const third: TaskDocument = { ...first, path: "E:/repo/spec/tasks/task-3.md" };
    // 候補が複数なので引き継がない = 別タスクの memoria_task_id を奪わない。
    expect(store.readOrMigrate(third)).toMatchObject({ memoria_task_id: null, status: "pending" });
    expect(store.find({ repoPath: "E:/repo", taskPath: "spec/tasks/task.md" })).toMatchObject({ memoria_task_id: "1" });
  });
});

function task(legacy: Record<string, unknown>): TaskDocument {
  return {
    path: "E:/repo/spec/tasks/task.md", repoPath: "E:/repo", title: "Task", body: "# Task",
    frontmatter: { task: "task", project: "repo", kind: "実装", created: "2026-08-08", ...legacy },
  };
}
