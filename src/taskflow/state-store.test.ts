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
});

function task(legacy: Record<string, unknown>): TaskDocument {
  return {
    path: "E:/repo/spec/tasks/task.md", repoPath: "E:/repo", title: "Task", body: "# Task",
    frontmatter: { task: "task", project: "repo", kind: "実装", created: "2026-08-08", ...legacy },
  };
}
