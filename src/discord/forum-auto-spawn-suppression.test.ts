import { describe, expect, it, vi } from "vitest";
import { ForumAutoSpawnSuppression, waitForExplicitForumSpawn } from "./forum-auto-spawn-suppression.js";

describe("ForumAutoSpawnSuppression", () => {
  it("suppresses a ThreadCreate auto-spawn after an explicit spawn in the same thread", async () => {
    vi.useFakeTimers();
    try {
      const suppression = new ForumAutoSpawnSuppression();
      const waiting = waitForExplicitForumSpawn(suppression, "thread-1", 1_000);
      suppression.suppressForExplicitSpawn("thread-1", Date.now());
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(waiting).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("expires suppression so ordinary Forum posts retain their auto-spawn path", () => {
    const suppression = new ForumAutoSpawnSuppression();
    suppression.suppressForExplicitSpawn("thread-1", 100);
    expect(suppression.isSuppressed("thread-1", 5_099)).toBe(true);
    expect(suppression.isSuppressed("thread-1", 5_100)).toBe(false);
  });
});
