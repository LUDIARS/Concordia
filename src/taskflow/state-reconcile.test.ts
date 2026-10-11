/** @implements spec/feature/task-workflow-v3.md — Actio task sync: status cache reconcile (CC-TF-SYNC-05) */

import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { findStatusDrift, reconcileTaskStatuses } from "./state-reconcile.js";
import { startTaskStatusReconcile, taskStatusReconcilePorts } from "./state-reconcile-scheduler.js";
import { TaskflowStateStore } from "./state-store.js";
import type { TaskStore } from "./store.js";
import type { TaskDocument, TaskStatus } from "./types.js";

const REPO = "E:/Document/Ars/Concordia";

function doc(path: string, status: TaskStatus): TaskDocument {
  return { path, repoPath: REPO, title: "t", body: "", frontmatter: {} as TaskDocument["frontmatter"], runtime: { status } as TaskDocument["runtime"] };
}

describe("findStatusDrift", () => {
  it("lists only v3 tasks whose cached status differs from Actio", () => {
    const cached = (_repo: string, reference: string): TaskStatus | null =>
      ({ "actio:a": "pending", "actio:b": "done" } as Record<string, TaskStatus>)[reference] ?? null;
    expect(findStatusDrift([doc("actio:a", "delegated"), doc("actio:b", "done"), doc("actio:c", "pending"), doc("spec/tasks/x.md", "done")], cached))
      .toEqual([
        { repoPath: REPO, reference: "actio:a", from: "pending", to: "delegated" },
        { repoPath: REPO, reference: "actio:c", from: null, to: "pending" },
      ]);
  });
});

describe("reconcileTaskStatuses", () => {
  it("writes nothing on a dry run and the Actio status when applied", async () => {
    const state = new TaskflowStateStore(makeTestDb());
    state.registerActioReference(REPO, "actio:a", "a", null);
    const store = { scan: vi.fn(async () => [doc("actio:a", "done")]) } as unknown as TaskStore;
    const ports = taskStatusReconcilePorts(store, state);

    const dry = await reconcileTaskStatuses(ports, { apply: false });
    expect(dry).toMatchObject({ checked: 1, applied: false, drift: [{ from: "pending", to: "done" }] });
    expect(state.find({ repoPath: REPO, taskPath: "actio:a" })?.status).toBe("pending");

    await reconcileTaskStatuses(ports, { apply: true });
    expect(state.find({ repoPath: REPO, taskPath: "actio:a" })?.status).toBe("done");
  });
});

describe("startTaskStatusReconcile", () => {
  it("runs on the interval and survives an unavailable Actio", async () => {
    vi.useFakeTimers();
    try {
      const scan = vi.fn(async (): Promise<TaskDocument[]> => { throw new Error("Actio down"); });
      const handle = startTaskStatusReconcile({ scan } as unknown as TaskStore, new TaskflowStateStore(makeTestDb()), 1000);
      await vi.advanceTimersByTimeAsync(2500);
      expect(scan).toHaveBeenCalledTimes(2);
      handle.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(scan).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
});
