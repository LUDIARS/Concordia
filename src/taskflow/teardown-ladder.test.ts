import { describe, expect, it, vi } from "vitest";
import { readTeardownLadder, scheduleTeardownLadder, startTeardownLadderWatch } from "./teardown-ladder.js";

describe("teardown ladder", () => {
  it("schedules exactly once per run", () => {
    let metadata = "{}";
    const row = { id: "s1", provider: "codex-cli", status: "active", metadata } as any;
    const repo = {
      appendEvent: vi.fn(),
      mergeMetadata: vi.fn((_id, patch) => { metadata = JSON.stringify(patch); row.metadata = metadata; }),
    } as any;
    expect(scheduleTeardownLadder(repo, row, "run-1", 10)).toBe(true);
    expect(scheduleTeardownLadder(repo, row, "run-1", 11)).toBe(false);
    expect(readTeardownLadder(metadata)?.started_at).toBe(10);
  });

  it("retries twice then forces end", async () => {
    vi.useFakeTimers();
    let now = 0;
    const row = { id: "s1", provider: "codex-cli", status: "active", metadata: "{}" } as any;
    const repo = {
      appendEvent: vi.fn(),
      mergeMetadata: vi.fn((_id, patch) => { row.metadata = JSON.stringify({ ...JSON.parse(row.metadata), ...patch }); }),
      listSessions: vi.fn(() => [row]),
    } as any;
    scheduleTeardownLadder(repo, row, "run-1", now);
    const endSession = vi.fn(async () => undefined);
    const watch = startTeardownLadderWatch({ sessions: repo, endSession, retrySec: 5, forceSec: 15, intervalMs: 1000, nowSec: () => now });
    now = 5; await vi.advanceTimersByTimeAsync(1000);
    now = 10; await vi.advanceTimersByTimeAsync(1000);
    now = 15; await vi.advanceTimersByTimeAsync(1000);
    expect(endSession).toHaveBeenCalledOnce();
    expect(repo.appendEvent.mock.calls.some((call: any[]) => call[0].kind === "teardown_forced")).toBe(true);
    watch.stop();
    vi.useRealTimers();
  });
});
