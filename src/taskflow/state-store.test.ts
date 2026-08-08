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
    const document = task({ status: "delegated", memoria_task_id: 797, assignee: "neco" });

    expect(store.readOrMigrate(document)).toMatchObject({
      status: "delegated", memoria_task_id: "797", assignee: "neco", memoria_registration_state: "created",
    });
    expect(document.frontmatter).toMatchObject({ status: "delegated", memoria_task_id: 797 });
  });

  it("durably claims registration so a second reconciliation cannot create a duplicate", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const store = new TaskflowStateStore(db);
    const document = task({});

    expect(store.claimMemoriaCreation(document)).toBe(true);
    expect(store.claimMemoriaCreation(document)).toBe(false);
    store.recordMemoriaTaskId(document, 42);
    expect(store.readOrMigrate(document)).toMatchObject({ memoria_task_id: "42", memoria_registration_state: "created" });
  });
});

function task(legacy: Record<string, unknown>): TaskDocument {
  return {
    path: "E:/repo/spec/tasks/task.md", repoPath: "E:/repo", title: "Task", body: "# Task",
    frontmatter: { task: "task", project: "repo", kind: "実装", created: "2026-08-08", ...legacy },
  };
}
