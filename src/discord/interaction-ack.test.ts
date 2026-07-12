import { describe, expect, it, vi } from "vitest";
import { startInteractionAckProbe } from "./interaction-ack.js";

describe("Discord interaction ack probe", () => {
  it("records a deferred interaction within the 3 second budget", () => {
    vi.useFakeTimers();
    let now = 1_000;
    const interaction = { createdTimestamp: 1_000, deferred: false, replied: false };
    const record = vi.fn();
    startInteractionAckProbe(interaction, record, { now: () => now, pollMs: 10 });
    interaction.deferred = true;
    now = 1_120;
    vi.advanceTimersByTime(10);
    expect(record).toHaveBeenCalledWith({ acknowledged: true, within_3s: true, duration_ms: 120 });
    vi.useRealTimers();
  });

  it("records a missed deadline once", () => {
    vi.useFakeTimers();
    let now = 1_000;
    const record = vi.fn();
    startInteractionAckProbe(
      { createdTimestamp: 1_000, deferred: false, replied: false },
      record,
      { now: () => now, pollMs: 10 },
    );
    now = 4_001;
    vi.advanceTimersByTime(10);
    vi.advanceTimersByTime(100);
    expect(record).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledWith({ acknowledged: false, within_3s: false, duration_ms: 3001 });
    vi.useRealTimers();
  });
});
