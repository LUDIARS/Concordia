/** @implements spec/feature/task-workflow-v3.md — Actio task sync: runs to task many-to-one (CC-TF-SYNC-03) */

import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { TaskflowStateStore } from "./state-store.js";

const KEY = { repoPath: "E:/Document/Ars/Concordia", taskPath: "actio:t1" };

function store(): TaskflowStateStore {
  const state = new TaskflowStateStore(makeTestDb(), () => 1);
  state.registerActioReference(KEY.repoPath, KEY.taskPath, "t1", null);
  return state;
}

describe("TaskflowStateStore.claimActioExecution", () => {
  it("keeps one run per task while the previous run is working", () => {
    const state = store();
    expect(state.claimActioExecution(KEY, "run-1", null)).toBe(true);
    expect(state.claimActioExecution(KEY, "run-1", null)).toBe(true);
    expect(state.claimActioExecution(KEY, "run-2", null, () => false)).toBe(false);
    expect(state.find(KEY)?.delegation_run_id).toBe("run-1");
  });

  it("accepts a new run once the previous run is over", () => {
    const state = store();
    state.claimActioExecution(KEY, "run-1", null);
    const asked: string[] = [];
    expect(state.claimActioExecution(KEY, "run-2", "s2", (runId) => { asked.push(runId); return true; })).toBe(true);
    expect(asked).toEqual(["run-1"]);
    expect(state.find(KEY)).toMatchObject({ delegation_run_id: "run-2", source_session: "s2" });
  });

  it("refuses an unregistered reference", () => {
    expect(store().claimActioExecution({ ...KEY, taskPath: "actio:other" }, "run-1", null, () => true)).toBe(false);
  });

  it("lists v3 rows for the status reconcile", () => {
    const state = store();
    expect(state.actioReferences()).toEqual([{ repo_path: "e:/document/ars/concordia", task_path: "actio:t1", status: "pending", subsidiary_id: null }]);
  });
});
