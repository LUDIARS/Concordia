import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureLoopHaltNotifier,
  createLoopBulkhead,
  listHaltedLoops,
  resetLoopBulkheadsForTest,
} from "./loop-bulkhead.js";

afterEach(resetLoopBulkheadsForTest);

describe("loop bulkhead", () => {
  it("halts only the failing loop after N consecutive failures and notifies once", async () => {
    const notify = vi.fn(async () => undefined);
    configureLoopHaltNotifier(notify);
    const failing = createLoopBulkhead("failing", { maxConsecutiveFailures: 3, now: () => 123 });
    const healthy = createLoopBulkhead("healthy", { maxConsecutiveFailures: 3 });
    const healthyTick = vi.fn();

    for (let index = 0; index < 3; index += 1) {
      await failing.run(() => { throw new Error("boom"); });
      await healthy.run(healthyTick);
    }
    await failing.run(() => { throw new Error("should not execute"); });
    await Promise.resolve();

    expect(failing.isHalted()).toBe(true);
    expect(healthy.isHalted()).toBe(false);
    expect(healthyTick).toHaveBeenCalledTimes(3);
    expect(notify).toHaveBeenCalledOnce();
    expect(listHaltedLoops()).toEqual([
      { name: "failing", consecutive_failures: 3, halted_at: 123, last_error: "boom" },
    ]);
  });

  it("resets the failure streak after a successful tick", async () => {
    const loop = createLoopBulkhead("flaky", { maxConsecutiveFailures: 2 });
    await loop.run(() => { throw new Error("first"); });
    await loop.run(() => undefined);
    await loop.run(() => { throw new Error("second"); });
    expect(loop.isHalted()).toBe(false);
  });
});
