import { describe, expect, it, vi } from "vitest";
import type { ConcordiaEvent } from "../events.js";
import { startParttimerClockout, type ParttimerClockoutDeps } from "./parttimer-clockout.js";

interface Timer { fn: () => void; ms: number; cleared: boolean }

function harness(patch: Partial<ParttimerClockoutDeps> = {}) {
  const timers: Timer[] = [];
  let handler: ((event: ConcordiaEvent) => void) | null = null;
  const endSession = vi.fn(async () => undefined);
  const sessionStatus = { value: "active" };
  const deps: ParttimerClockoutDeps = {
    runs: { findRun: () => ({ id: "run-1", call_name: "kaizen-daily", child_session_id: "sess-1" }) },
    categoryOf: () => "parttimer",
    sessions: { findSession: () => ({ id: "sess-1", status: sessionStatus.value }) },
    endSession,
    graceMs: 1000,
    subscribe: (h) => { handler = h; return () => { handler = null; }; },
    setTimer: (fn, ms) => {
      const timer: Timer = { fn, ms, cleared: false };
      timers.push(timer);
      return { clear: () => { timer.cleared = true; } };
    },
    ...patch,
  };
  const handle = startParttimerClockout(deps);
  const emit = (status: string, runId = "run-1", parentSessionId: string | null = "parent") =>
    handler?.({
      type: "delegation.run_changed",
      parent_session_id: parentSessionId,
      run_id: runId,
      status,
      ts: 1,
    } as ConcordiaEvent);
  return { handle, timers, endSession, emit, sessionStatus };
}

describe("parttimer clock-out", () => {
  it("ends a lingering parttimer session after the grace period", () => {
    const h = harness();
    h.emit("completed");
    expect(h.timers).toHaveLength(1);
    h.timers[0]!.fn();
    expect(h.endSession).toHaveBeenCalledWith("sess-1");
  });

  it("handles a terminal scheduled run without a parent session", () => {
    const h = harness();
    h.emit("completed", "run-1", null);
    expect(h.timers).toHaveLength(1);
    h.timers[0]!.fn();
    expect(h.endSession).toHaveBeenCalledWith("sess-1");
  });

  it("does not end a session that already clocked out on its own", () => {
    const h = harness();
    h.emit("completed");
    h.sessionStatus.value = "ended";
    h.timers[0]!.fn();
    expect(h.endSession).not.toHaveBeenCalled();
  });

  it("schedules only one timer per run even on duplicate events", () => {
    const h = harness();
    h.emit("completed");
    h.emit("completed");
    expect(h.timers).toHaveLength(1);
  });

  it("ignores non-terminal statuses and non-parttimer templates", () => {
    const employee = harness({ categoryOf: () => "employee" });
    employee.emit("completed");
    expect(employee.timers).toHaveLength(0);

    const h = harness();
    h.emit("running");
    expect(h.timers).toHaveLength(0);
  });

  it("ignores runs without a linked child session", () => {
    const h = harness({ runs: { findRun: () => ({ id: "run-1", call_name: "kaizen-daily", child_session_id: null }) } });
    h.emit("completed");
    expect(h.timers).toHaveLength(0);
  });

  it("stop() clears pending timers and unsubscribes", () => {
    const h = harness();
    h.emit("completed");
    h.handle.stop();
    expect(h.timers[0]!.cleared).toBe(true);
    h.emit("completed", "run-2");
    expect(h.timers).toHaveLength(1);
  });
});
