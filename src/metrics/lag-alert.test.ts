import { describe, expect, it, vi } from "vitest";
import { EventLoopLagAlert } from "./lag-alert.js";

const healthy = { mean: 1, p50: 1, p99: 10, max: 15 };
const lagged = { mean: 100, p50: 100, p99: 250, max: 400 };

describe("EventLoopLagAlert", () => {
  it("notifies after consecutive threshold breaches and honors cooldown", async () => {
    let now = 1_000;
    const notify = vi.fn(async () => undefined);
    const alert = new EventLoopLagAlert({
      thresholdMs: 200,
      consecutiveSamples: 2,
      cooldownMs: 5_000,
      now: () => now,
      notify,
    });
    alert.observe(lagged);
    alert.observe(lagged);
    alert.observe(lagged);
    await Promise.resolve();
    expect(notify).toHaveBeenCalledOnce();

    now += 5_000;
    alert.observe(lagged);
    await Promise.resolve();
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("stays silent while healthy and resets a partial breach streak", async () => {
    const notify = vi.fn();
    const alert = new EventLoopLagAlert({
      thresholdMs: 200,
      consecutiveSamples: 2,
      cooldownMs: 1_000,
      notify,
    });
    alert.observe(lagged);
    alert.observe(healthy);
    alert.observe(lagged);
    await Promise.resolve();
    expect(notify).not.toHaveBeenCalled();
  });
});
