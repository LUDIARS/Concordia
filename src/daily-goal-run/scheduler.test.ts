import { describe, expect, it, vi } from "vitest";
import { startDailyGoalScheduler } from "./scheduler.js";

describe("startDailyGoalScheduler", () => {
  it("ticks the service and stops idempotently", async () => {
    const tick = vi.fn(async () => undefined);
    const handle = startDailyGoalScheduler({ service: { tick }, now: () => 42, intervalMs: 60_000 });
    await handle.tick();
    expect(tick).toHaveBeenCalledWith(42);
    handle.stop();
    handle.stop();
    await handle.tick();
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it("does not overlap ticks", async () => {
    let release: () => void = () => undefined;
    const tick = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const handle = startDailyGoalScheduler({ service: { tick }, intervalMs: 60_000 });
    const first = handle.tick();
    await handle.tick();
    expect(tick).toHaveBeenCalledTimes(1);
    release();
    await first;
    handle.stop();
  });
});
