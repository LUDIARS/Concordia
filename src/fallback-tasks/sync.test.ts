import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { applyMigrations } from "../db/schema.js";
import { ActioTaskClient, ActioTaskError } from "./actio-client.js";
import { CcTaskRepository } from "./repository.js";
import { syncOneTask } from "./sync.js";

describe("Cc Task Actio sync", () => {
  it("keeps a task pending while Actio is unavailable", async () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const repo = new CcTaskRepository(db);
    const task = repo.create({ title: "offline" }).task;
    const actio = {
      findByConcordiaId: vi.fn(async () => { throw new ActioTaskError("offline", "unavailable"); }),
    } as unknown as ActioTaskClient;
    await syncOneTask(repo, actio);
    expect(repo.find(task.id)?.actio_sync_state).toBe("pending");
    db.close();
  });

  it("reuses an Actio task with the same pluginRef", async () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const repo = new CcTaskRepository(db);
    const task = repo.create({ title: "recover" }).task;
    const actio = {
      findByConcordiaId: vi.fn(async () => ({ id: "actio-existing", pluginRef: task.id })),
      update: vi.fn(async () => undefined),
      create: vi.fn(),
    } as unknown as ActioTaskClient;
    await syncOneTask(repo, actio);
    expect(actio.create).not.toHaveBeenCalled();
    expect(repo.find(task.id)).toMatchObject({ actio_task_id: "actio-existing", actio_sync_state: "synced" });
    db.close();
  });

  it("leaves a newer local edit pending when an in-flight sync completes", async () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const repo = new CcTaskRepository(db);
    const task = repo.create({ title: "old title" }).task;
    const actio = {
      findByConcordiaId: vi.fn(async () => {
        repo.update(task.id, { title: "new title" });
        return { id: "actio-existing", pluginRef: task.id };
      }),
      update: vi.fn(async () => undefined),
    } as unknown as ActioTaskClient;

    await syncOneTask(repo, actio);

    expect(repo.find(task.id)).toMatchObject({ title: "new title", actio_sync_state: "pending" });
    db.close();
  });

  it("queues a newer local edit after an in-flight create succeeds", async () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const repo = new CcTaskRepository(db);
    const task = repo.create({ title: "old title" }).task;
    const actio = {
      findByConcordiaId: vi.fn(async () => null),
      create: vi.fn(async () => {
        repo.update(task.id, { title: "new title" });
        return { id: "actio-created", pluginRef: task.id };
      }),
    } as unknown as ActioTaskClient;

    await syncOneTask(repo, actio);

    expect(repo.find(task.id)).toMatchObject({
      title: "new title",
      actio_task_id: "actio-created",
      actio_sync_state: "pending",
    });
    db.close();
  });

  it("does not mark an edited unknown task synced with stale remote content", async () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const repo = new CcTaskRepository(db);
    const task = repo.create({ title: "old title" }).task;
    expect(repo.claim(task.id)).toBe(true);
    expect(repo.beginCreate(task.id)).toBe(true);
    repo.recoverInterruptedClaims();
    const actio = {
      findByConcordiaId: vi.fn(async () => {
        repo.update(task.id, { title: "new title" });
        return { id: "actio-existing", pluginRef: task.id };
      }),
      update: vi.fn(async () => undefined),
    } as unknown as ActioTaskClient;

    await syncOneTask(repo, actio);

    expect(repo.find(task.id)).toMatchObject({ title: "new title", actio_sync_state: "unknown" });
    db.close();
  });

  it("never makes an unknown POST outcome eligible for another POST", async () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const repo = new CcTaskRepository(db);
    const task = repo.create({ title: "uncertain create" }).task;
    expect(repo.claim(task.id)).toBe(true);
    expect(repo.beginCreate(task.id)).toBe(true);
    repo.recoverInterruptedClaims();
    const actio = {
      findByConcordiaId: vi.fn()
        .mockRejectedValueOnce(new ActioTaskError("offline", "unavailable"))
        .mockResolvedValueOnce(null),
      create: vi.fn(),
    } as unknown as ActioTaskClient;

    await syncOneTask(repo, actio);
    expect(repo.find(task.id)?.actio_sync_state).toBe("unknown");
    await syncOneTask(repo, actio);
    expect(actio.create).not.toHaveBeenCalled();
    expect(repo.find(task.id)?.actio_sync_state).toBe("unknown");
    db.close();
  });

  it("rotates unresolved unknown outcomes instead of starving later rows", async () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    const repo = new CcTaskRepository(db);
    const first = repo.create({ title: "first" }, 1).task;
    const second = repo.create({ title: "second" }, 2).task;
    expect(repo.claim(first.id)).toBe(true);
    expect(repo.claim(second.id)).toBe(true);
    expect(repo.beginCreate(first.id)).toBe(true);
    expect(repo.beginCreate(second.id)).toBe(true);
    repo.recoverInterruptedClaims();
    const actio = {
      findByConcordiaId: vi.fn(async () => null),
      create: vi.fn(),
    } as unknown as ActioTaskClient;

    await syncOneTask(repo, actio);
    await syncOneTask(repo, actio);

    expect(actio.findByConcordiaId).toHaveBeenNthCalledWith(1, first.id);
    expect(actio.findByConcordiaId).toHaveBeenNthCalledWith(2, second.id);
    expect(actio.create).not.toHaveBeenCalled();
    db.close();
  });
});
