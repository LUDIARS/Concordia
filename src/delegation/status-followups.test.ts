import { describe, expect, it, vi } from "vitest";
import { isWaitOnlyPartial, notifiedStatus, runAfterRecorded } from "./status-followups.js";

describe("delegation status follow-ups", () => {
  it("identifies a partial report that only leaves waits", () => {
    expect(isWaitOnlyPartial({ status: "partial", remainingCount: 1, workRemainingCount: 0 })).toBe(true);
    expect(isWaitOnlyPartial({ status: "partial", remainingCount: 2, workRemainingCount: 1 })).toBe(false);
    expect(isWaitOnlyPartial({ status: "completed", remainingCount: 0, workRemainingCount: 0 })).toBe(false);
  });

  it("tells the parent a wait-only partial is partial even though the run is closed as completed", () => {
    expect(notifiedStatus({ partialFailure: false, workPartial: false, waitOnlyPartial: true, persisted: "completed" })).toBe("partial");
    expect(notifiedStatus({ partialFailure: false, workPartial: false, waitOnlyPartial: false, persisted: "completed" })).toBe("completed");
    expect(notifiedStatus({ partialFailure: true, workPartial: true, waitOnlyPartial: false, persisted: "failed" })).toBe("failed");
  });

  it("swallows a follow-up failure after the status was recorded and logs it without the response turning into 500", async () => {
    const warn = vi.fn();
    await expect(runAfterRecorded("run-1", "decomposition check", async () => { throw new Error("Actio task service unavailable"); }, warn))
      .resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("[delegation] run run-1: decomposition check skipped after status recorded (Actio task service unavailable)");
  });
});
