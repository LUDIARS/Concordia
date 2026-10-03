import { describe, expect, it, vi } from "vitest";
import { isSessionEndPending, stopCompletedSessionProcesses } from "../src/control/session-end-process.js";

describe("session-end process lifecycle", () => {
  const nowSec = 10_000;
  const metadata = (pids: Record<string, number>) => JSON.stringify({
    ...pids,
    concordia_spawn_id: "spawn-instance-1234",
    start_iso: new Date((nowSec - 60) * 1000).toISOString(),
  });
  const observed = (...pids: number[]) => async () => pids.map((pid) => ({
    pid,
    kind: "lictor" as const,
    sessionId: null,
    ageSec: 60,
    cmd: "lictor.mjs",
  }));
  it("shares an in-flight stop between completion and timeout recovery", async () => {
    let alive = true;
    let complete!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const stopProcess = vi.fn(async () => {
      started();
      await new Promise<void>((resolve) => { complete = resolve; });
      alive = false;
      return { ok: true as const, method: "taskkill" as const };
    });
    const deps = { isAlive: () => alive, stopProcess, scanProcesses: observed(501), nowSec: () => nowSec };
    const first = stopCompletedSessionProcesses(metadata({ lictor_pid: 501 }), deps);
    await ready;
    const second = stopCompletedSessionProcesses(metadata({ lictor_pid: 501 }), deps);
    await Promise.resolve();
    await Promise.resolve();
    complete();
    expect((await Promise.all([first, second])).every((result) => result.ok)).toBe(true);
    expect(stopProcess).toHaveBeenCalledTimes(1);
  });

  it("does not call an accepted stop a completed process exit", async () => {
    const result = await stopCompletedSessionProcesses(metadata({ lictor_pid: 601 }), {
      isAlive: () => true, stopProcess: async () => ({ ok: true, method: "signal" }),
      scanProcesses: observed(601), nowSec: () => nowSec,
    });
    expect(result.ok).toBe(false);
    expect(result.failed[0]?.error).toContain("reconciliation");
  });
  it("recognizes only a finite pending timestamp", () => {
    expect(isSessionEndPending('{"session_end_pending_at":123}')).toBe(true);
    expect(isSessionEndPending('{"session_end_pending_at":"123"}')).toBe(false);
    expect(isSessionEndPending('{"session_end_pending_at":null}')).toBe(false);
    expect(isSessionEndPending("not-json")).toBe(false);
  });

  it("stops live Lictor and agent-client PIDs after completion", async () => {
    const alive = new Set([101, 102]);
    const stopProcess = vi.fn(async (pid: number) => {
      alive.delete(pid);
      return { ok: true as const, method: "taskkill" as const };
    });
    const result = await stopCompletedSessionProcesses(
      metadata({ lictor_pid: 101, agent_client_pid: 102 }),
      { isAlive: (pid) => alive.has(pid), stopProcess, scanProcesses: observed(101, 102), nowSec: () => nowSec },
    );

    expect(result).toEqual({ ok: true, stopped: [101, 102], alreadyStopped: [], failed: [] });
    expect(stopProcess.mock.calls).toEqual([[101], [102]]);
  });

  it("is idempotent when the recorded process is already gone", async () => {
    const stopProcess = vi.fn();
    const result = await stopCompletedSessionProcesses(
      metadata({ lictor_pid: 201 }),
      { isAlive: () => false, stopProcess, scanProcesses: observed(), nowSec: () => nowSec },
    );

    expect(result).toEqual({ ok: true, stopped: [], alreadyStopped: [201], failed: [] });
    expect(stopProcess).not.toHaveBeenCalled();
  });

  it("reports failure so the pending marker can remain for lost fallback", async () => {
    const result = await stopCompletedSessionProcesses(
      metadata({ lictor_pid: 301 }),
      {
        isAlive: () => true,
        stopProcess: async () => ({ ok: false, error: "access denied" }),
        scanProcesses: observed(301),
        nowSec: () => nowSec,
      },
    );

    expect(result.ok).toBe(false);
    expect(result.failed).toEqual([{ pid: 301, error: "access denied" }]);
  });

  it("refuses a live PID from a different generation", async () => {
    const stopProcess = vi.fn();
    const result = await stopCompletedSessionProcesses(
      metadata({ lictor_pid: 401 }),
      {
        isAlive: () => true,
        stopProcess,
        scanProcesses: async () => [{ pid: 401, kind: "lictor", sessionId: null, ageSec: 5, cmd: "lictor.mjs" }],
        nowSec: () => nowSec,
      },
    );

    expect(result.ok).toBe(false);
    expect(result.failed[0]?.error).toContain("generation");
    expect(stopProcess).not.toHaveBeenCalled();
  });
});
