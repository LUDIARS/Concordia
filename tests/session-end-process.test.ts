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
  it("recognizes only a finite pending timestamp", () => {
    expect(isSessionEndPending('{"session_end_pending_at":123}')).toBe(true);
    expect(isSessionEndPending('{"session_end_pending_at":"123"}')).toBe(false);
    expect(isSessionEndPending('{"session_end_pending_at":null}')).toBe(false);
    expect(isSessionEndPending("not-json")).toBe(false);
  });

  it("stops live Lictor and agent-client PIDs after completion", async () => {
    const stopProcess = vi.fn(async () => ({ ok: true as const, method: "taskkill" as const }));
    const result = await stopCompletedSessionProcesses(
      metadata({ lictor_pid: 101, agent_client_pid: 102 }),
      { isAlive: () => true, stopProcess, scanProcesses: observed(101, 102), nowSec: () => nowSec },
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
