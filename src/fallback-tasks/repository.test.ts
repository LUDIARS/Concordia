import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "../db/schema.js";
import { CcTaskRepository } from "./repository.js";

describe("CcTaskRepository", () => {
  it("keeps tasks locally and makes source_key creation idempotent", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const repo = new CcTaskRepository(db);
    const first = repo.create({ source_key: "request-1", title: "Actio 復旧待ち" });
    const repeated = repo.create({ source_key: "request-1", title: "duplicate" });
    expect(first.created).toBe(true);
    expect(repeated.created).toBe(false);
    expect(repeated.task.id).toBe(first.task.id);
    expect(repo.list()).toHaveLength(1);
    expect(repo.list()[0]?.actio_sync_state).toBe("pending");
    db.close();
  });

  it("requeues a locally updated synced task without deleting it", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const repo = new CcTaskRepository(db);
    const task = repo.create({ title: "keep me" }).task;
    repo.setSync(task.id, "pending", "synced", { actioTaskId: "actio-1" });
    const updated = repo.update(task.id, { status: "done" });
    expect(updated).toMatchObject({ status: "done", actio_task_id: "actio-1", actio_sync_state: "pending" });
    expect(repo.find(task.id)).not.toBeNull();
    db.close();
  });

  it("does not let a stale sync completion overwrite a newer local update", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const repo = new CcTaskRepository(db);
    const task = repo.create({ title: "old title" }).task;
    expect(repo.claim(task.id)).toBe(true);
    repo.update(task.id, { title: "new title" });

    expect(repo.setSync(task.id, "checking", "synced", { actioTaskId: "actio-stale" })).toBe(false);
    expect(repo.find(task.id)).toMatchObject({
      title: "new title",
      actio_task_id: null,
      actio_sync_state: "pending",
    });
    db.close();
  });

  it("marks a local edit during an Actio POST as unknown", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const repo = new CcTaskRepository(db);
    const task = repo.create({ title: "old title" }).task;
    expect(repo.claim(task.id)).toBe(true);
    expect(repo.beginCreate(task.id)).toBe(true);

    expect(repo.update(task.id, { title: "new title" })).toMatchObject({
      title: "new title",
      actio_sync_state: "unknown",
    });
    db.close();
  });

  it("keeps an already unknown create outcome unknown after a local edit", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const repo = new CcTaskRepository(db);
    const task = repo.create({ title: "old title" }).task;
    expect(repo.claim(task.id)).toBe(true);
    expect(repo.beginCreate(task.id)).toBe(true);
    repo.recoverInterruptedClaims();

    expect(repo.update(task.id, { title: "new title" })).toMatchObject({
      title: "new title",
      actio_sync_state: "unknown",
    });
    db.close();
  });
});
