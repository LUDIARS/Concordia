import { describe, expect, it, vi } from "vitest";
import { isSessionEndPending, stopCompletedSessionProcesses } from "../src/control/session-end-process.js";

describe("session-end process lifecycle", () => {
  it("recognizes only a finite pending timestamp", () => {
    expect(isSessionEndPending('{"session_end_pending_at":123}')).toBe(true);
    expect(isSessionEndPending('{"session_end_pending_at":"123"}')).toBe(false);
    expect(isSessionEndPending('{"session_end_pending_at":null}')).toBe(false);
    expect(isSessionEndPending("not-json")).toBe(false);
  });

  it("stops live Lictor and agent-client PIDs after completion", async () => {
    const stopProcess = vi.fn(async () => ({ ok: true as const, method: "taskkill" as const }));
    const result = await stopCompletedSessionProcesses(
      '{"lictor_pid":101,"agent_client_pid":102}',
      { isAlive: () => true, stopProcess },
    );

    expect(result).toEqual({ ok: true, stopped: [101, 102], alreadyStopped: [], failed: [] });
    expect(stopProcess.mock.calls).toEqual([[101], [102]]);
  });

  it("is idempotent when the recorded process is already gone", async () => {
    const stopProcess = vi.fn();
    const result = await stopCompletedSessionProcesses(
      '{"lictor_pid":201}',
      { isAlive: () => false, stopProcess },
    );

    expect(result).toEqual({ ok: true, stopped: [], alreadyStopped: [201], failed: [] });
    expect(stopProcess).not.toHaveBeenCalled();
  });

  it("reports failure so the pending marker can remain for lost fallback", async () => {
    const result = await stopCompletedSessionProcesses(
      '{"lictor_pid":301}',
      {
        isAlive: () => true,
        stopProcess: async () => ({ ok: false, error: "access denied" }),
      },
    );

    expect(result.ok).toBe(false);
    expect(result.failed).toEqual([{ pid: 301, error: "access denied" }]);
  });
});
