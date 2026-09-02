import { describe, expect, it, vi } from "vitest";
import { createPruneScheduler } from "./prune-scheduler.js";

describe("createPruneScheduler", () => {
  it("runs immediately, then at most once per interval", () => {
    let now = 1_000;
    const prune = vi.fn();
    const run = createPruneScheduler(500, () => now);

    expect(run(prune)).toBe(true);
    now = 1_499;
    expect(run(prune)).toBe(false);
    now = 1_500;
    expect(run(prune)).toBe(true);
    expect(prune).toHaveBeenCalledTimes(2);
  });

  it("retries on the next call when pruning throws", () => {
    const failure = new Error("database busy");
    const prune = vi.fn()
      .mockImplementationOnce(() => { throw failure; })
      .mockImplementationOnce(() => undefined);
    const run = createPruneScheduler(500, () => 1_000);

    expect(() => run(prune)).toThrow(failure);
    expect(run(prune)).toBe(true);
    expect(prune).toHaveBeenCalledTimes(2);
  });

  it.each([0, -1, Number.POSITIVE_INFINITY, Number.NaN])("rejects invalid interval %s", (intervalMs) => {
    expect(() => createPruneScheduler(intervalMs)).toThrow(RangeError);
  });
});
