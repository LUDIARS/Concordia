import { describe, expect, it, vi } from "vitest";
import { createTestForumRefreshTrigger } from "./test-forum-trigger.js";

describe("createTestForumRefreshTrigger", () => {
  it("reconciles PR updates and runs one trailing refresh for overlapping events", async () => {
    const releases: Array<() => void> = [];
    const reconcile = vi.fn(async () => new Promise<void>((resolve) => { releases.push(resolve); }));
    const trigger = createTestForumRefreshTrigger({ reconcile, warn: vi.fn() });

    const first = trigger("pr.changed");
    const overlapping = trigger("pr.changed");
    expect(reconcile).toHaveBeenCalledOnce();
    expect(overlapping).toBe(first);
    releases.shift()!();
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(2));
    releases.shift()!();
    await first;

    const later = trigger("pr.changed");
    expect(reconcile).toHaveBeenCalledTimes(3);
    releases.shift()!();
    await later;
  });
});
