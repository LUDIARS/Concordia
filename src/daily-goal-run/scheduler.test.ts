import { describe, expect, it, vi } from "vitest";
import { startDailyGoalScheduler } from "./scheduler.js";
import type { DailyGoalRunService } from "./service.js";

describe("startDailyGoalScheduler", () => {
  it("ticks the service, forwards session loss and stops idempotently", async () => {
    const tick = vi.fn(async () => undefined);
    const onSessionLost = vi.fn();
    let handler: ((sessionId: string) => void) | null = null;
    const unsubscribe = vi.fn();
    const handle = startDailyGoalScheduler({
      service: { tick, onSessionLost } as unknown as DailyGoalRunService,
      subscribeSessionGone: (h) => { handler = h; return unsubscribe; },
      now: () => 42,
      intervalMs: 60_000,
    });
    await handle.tick();
    expect(tick).toHaveBeenCalledWith(42);
    handler!("s1");
    expect(onSessionLost).toHaveBeenCalledWith("s1", 42);
    handle.stop();
    handle.stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    await handle.tick();
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it("does not overlap ticks", async () => {
    let release: () => void = () => undefined;
    const tick = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const handle = startDailyGoalScheduler({ service: { tick, onSessionLost: vi.fn() } as unknown as DailyGoalRunService, intervalMs: 60_000 });
    const first = handle.tick();
    await handle.tick();
    expect(tick).toHaveBeenCalledTimes(1);
    release();
    await first;
    handle.stop();
  });
});
