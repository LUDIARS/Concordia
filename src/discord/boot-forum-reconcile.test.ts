import { describe, expect, it, vi } from "vitest";
import { runBootForumReconciliations, scheduleBootForumReconciliations } from "./boot-forum-reconcile.js";

describe("runBootForumReconciliations", () => {
  it("runs Session and Test reconciliations independently", async () => {
    const session = vi.fn(async () => { throw new Error("session unavailable"); });
    const test = vi.fn(async () => undefined);
    const log = { info: vi.fn(), warn: vi.fn() };

    await expect(runBootForumReconciliations({
      reconcileSessionForum: session,
      reconcileTestForum: test,
      log,
    })).resolves.toBeUndefined();

    expect(session).toHaveBeenCalledOnce();
    expect(test).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("session unavailable"));
    expect(log.info).toHaveBeenCalledWith("test-forum boot reconcile completed");
  });

  it("schedules startup reconciliation immediately when the configured delay is zero", async () => {
    const session = vi.fn(async () => undefined);
    const test = vi.fn(async () => undefined);
    let scheduled: (() => Promise<void>) | null = null;
    const schedule = vi.fn((_label: string, fn: () => Promise<void>) => { scheduled = fn; });

    scheduleBootForumReconciliations({
      delayMs: 0,
      schedule,
      reconcileSessionForum: session,
      reconcileTestForum: test,
      log: { info: vi.fn(), warn: vi.fn() },
    });

    expect(schedule).toHaveBeenCalledWith("forum boot reconcile", expect.any(Function), 0);
    await scheduled!();
    expect(session).toHaveBeenCalledOnce();
    expect(test).toHaveBeenCalledOnce();
  });
});
