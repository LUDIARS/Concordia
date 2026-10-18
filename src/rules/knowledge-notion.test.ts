import { describe, expect, it, vi } from "vitest";
import { NOTION_MIN_INTERVAL_MS, createRateGate, nextDelayMs } from "./knowledge-notion.js";

describe("nextDelayMs (chat-knowledge-C-5)", () => {
  it("waits so requests are at least the minimum interval apart", () => {
    expect(nextDelayMs(null, 10, 334)).toBe(0);
    expect(nextDelayMs(1000, 1100, 334)).toBe(234);
    expect(nextDelayMs(1000, 2000, 334)).toBe(0);
  });
});

describe("createRateGate", () => {
  it("keeps requests at most 3 per second", async () => {
    const clock = { ms: 1_000 };
    const at: number[] = [];
    const sleep = vi.fn(async (ms: number) => { clock.ms += ms; });
    const gate = createRateGate({ nowMs: () => clock.ms, sleep });
    for (let i = 0; i < 4; i += 1) {
      await gate.wait();
      at.push(clock.ms);
    }
    expect(sleep).toHaveBeenCalledTimes(3);
    for (let i = 1; i < at.length; i += 1) expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(NOTION_MIN_INTERVAL_MS);
  });
});
