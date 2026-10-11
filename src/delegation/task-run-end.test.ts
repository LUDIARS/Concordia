/** @implements spec/feature/task-workflow-v3.md — Actio task sync: runs to task many-to-one (CC-TF-SYNC-03) */

import { describe, expect, it, vi } from "vitest";
import type { TaskStore } from "../taskflow/store.js";
import { recordDelegationTaskRunEnd } from "./task-run-end.js";

const run = (args: unknown) => ({ id: "run-1", args_json: JSON.stringify(args), subsidiary_id: null });

describe("recordDelegationTaskRunEnd", () => {
  it("closes the run on the task it was bound to", async () => {
    const recordRunEnd = vi.fn(async () => undefined);
    await recordDelegationTaskRunEnd({ recordRunEnd } as unknown as TaskStore,
      run({ target_repo: "E:/Document/Ars/Concordia", taskflow_reference: "actio:t1" }), "completed", vi.fn());
    expect(recordRunEnd).toHaveBeenCalledWith("E:/Document/Ars/Concordia", "actio:t1", "run-1", "completed", null);
  });

  it("ignores runs without an Actio task and reports a failed write without throwing", async () => {
    const recordRunEnd = vi.fn(async () => { throw new Error("Actio down"); });
    const onError = vi.fn();
    const store = { recordRunEnd } as unknown as TaskStore;
    await recordDelegationTaskRunEnd(store, run({ task: "x" }), "failed", onError);
    expect(recordRunEnd).not.toHaveBeenCalled();
    await recordDelegationTaskRunEnd(store, { ...run({}), args_json: "{broken" }, "failed", onError);
    await recordDelegationTaskRunEnd(store, run({ target_repo: "E:/r", taskflow_reference: "actio:t" }), "failed", onError);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
