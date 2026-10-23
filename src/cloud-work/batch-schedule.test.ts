import { describe, expect, it, vi } from "vitest";
import { cloudBatchKickInterval, startCloudBatchSchedule } from "./batch-schedule.js";

describe("cloud batch schedule", () => {
  it("runs only with cloud configuration and clamps the interval", () => {
    expect(cloudBatchKickInterval({})).toBeUndefined();
    expect(cloudBatchKickInterval({ CONCORDIA_CLOUD_CONFIG_FILE: "c.json" })).toBe(180_000);
    expect(cloudBatchKickInterval({ CONCORDIA_CLOUD_CONFIG_FILE: "c.json", CONCORDIA_CLOUD_KICK_INTERVAL_SEC: "5" })).toBe(60_000);
    expect(cloudBatchKickInterval({ CONCORDIA_CLOUD_CONFIG_FILE: "c.json", CONCORDIA_CLOUD_KICK_INTERVAL_SEC: "x" })).toBe(180_000);
  });
  it("sweeps on each interval, swallows failures and can be stopped", async () => {
    vi.useFakeTimers();
    try {
      const kicker = { tickAll: vi.fn(async () => { throw new Error("boom"); }) };
      const stop = startCloudBatchSchedule(kicker, { CONCORDIA_CLOUD_CONFIG_FILE: "c.json" });
      await vi.advanceTimersByTimeAsync(360_000);
      expect(kicker.tickAll).toHaveBeenCalledTimes(2);
      await stop();
      await vi.advanceTimersByTimeAsync(360_000);
      expect(kicker.tickAll).toHaveBeenCalledTimes(2);
      const idle = { tickAll: vi.fn(async () => {}) };
      startCloudBatchSchedule(idle, {});
      await vi.advanceTimersByTimeAsync(360_000);
      expect(idle.tickAll).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});
