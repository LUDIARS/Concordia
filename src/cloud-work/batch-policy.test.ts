import { describe, expect, it } from "vitest";
import { batchFinished, selectShardsToKick, shardPhase, type AttemptJournal } from "./batch-policy.js";

const none: AttemptJournal = { intent: false, receipt: null, reconciliationRemoteId: null, verified: false };
const submitted = (remoteId: string): AttemptJournal => ({ intent: true, receipt: { state: "submitted", remoteId }, reconciliationRemoteId: null, verified: false });

describe("cloud batch kick policy", () => {
  it("maps journal and provider observation to phases without inferring completion", () => {
    const observed = new Map([["task_a", "pending" as const], ["task_b", "ready" as const], ["task_c", "error" as const]]);
    expect(shardPhase(none, observed)).toBe("queued");
    expect(shardPhase({ ...none, intent: true }, observed)).toBe("unknown");
    expect(shardPhase({ intent: true, receipt: { state: "submission_unknown" }, reconciliationRemoteId: null, verified: false }, observed)).toBe("unknown");
    expect(shardPhase(submitted("task_a"), observed)).toBe("running");
    expect(shardPhase(submitted("task_missing"), observed)).toBe("running");
    expect(shardPhase(submitted("task_b"), observed)).toBe("remote_ready");
    expect(shardPhase(submitted("task_c"), observed)).toBe("remote_error");
    expect(shardPhase({ intent: true, receipt: { state: "submission_unknown" }, reconciliationRemoteId: "task_b", verified: false }, observed)).toBe("remote_ready");
    expect(shardPhase({ ...submitted("task_a"), verified: true }, observed)).toBe("collected");
  });
  it("never exceeds concurrency; unknown keeps its slot and is never re-kicked", () => {
    expect(selectShardsToKick(["queued", "queued", "queued"], 1, false)).toEqual([0]);
    expect(selectShardsToKick(["unknown", "queued", "queued"], 1, false)).toEqual([]);
    expect(selectShardsToKick(["running", "remote_ready", "queued", "queued"], 3, false)).toEqual([2, 3]);
    expect(selectShardsToKick(["remote_error", "queued"], 1, false)).toEqual([1]);
    expect(selectShardsToKick(["queued", "queued"], 2, true)).toEqual([]);
  });
  it("is finished only when every shard has left the provider queue", () => {
    expect(batchFinished(["remote_ready", "remote_error", "collected"])).toBe(true);
    expect(batchFinished(["remote_ready", "unknown"])).toBe(false);
    expect(batchFinished(["queued"])).toBe(false);
  });
});
