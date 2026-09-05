import { describe, expect, it, vi } from "vitest";
import type { DelegationRunRow } from "../db/delegation-repo.js";
import type { SessionRow } from "../shared/types.js";
import type { RunningAgentProc } from "../control/agent-process-scan.js";
import type { StopResult } from "../control/stop-session.js";
import { reapZombieRuns, scanFinishedRuns } from "./finished-run-reaper.js";
import { DEFAULT_ZOMBIE_GRACE_MS, findZombieRuns } from "./zombie-run-detect.js";

const NOW = 1_788_600_000_000;
const PROCESS_AGE_SEC = 60 * 60;

function run(overrides: Partial<DelegationRunRow>): DelegationRunRow {
  return {
    id: "run-1",
    template_id: "tpl-1",
    category: "employee",
    call_name: "opus-xhigh",
    target_provider: "claude",
    parent_session_id: null,
    child_session_id: "lictor-child",
    args_json: "{}",
    rendered_prompt: "",
    prompt_file_path: "",
    spawn_pid: 100,
    spawn_command: null,
    triggered_by: "claude-cc",
    status: "completed",
    error: null,
    queue_payload_json: null,
    finished_at: NOW - 60 * 60_000,
    created_at: NOW - 2 * 60 * 60_000,
    ...overrides,
  } as DelegationRunRow;
}

function session(pid: number | null): SessionRow {
  return {
    id: "lictor-child",
    metadata: pid === null ? null : JSON.stringify({
      lictor_pid: pid,
      concordia_spawn_id: "00000000-0000-4000-8000-000000004242",
      start_iso: new Date(NOW - PROCESS_AGE_SEC * 1000).toISOString(),
    }),
  } as SessionRow;
}

function observedProcesses(pid = 4242, ageSec = PROCESS_AGE_SEC): RunningAgentProc[] {
  return [{ pid, kind: "lictor", sessionId: null, ageSec, cmd: "lictor.mjs" }];
}

describe("findZombieRuns", () => {
  const findSession = (): SessionRow => session(4242);

  it("flags a finished run whose child process is still alive", () => {
    const zombies = findZombieRuns({
      runs: [run({})],
      findSession,
      processes: observedProcesses(),
      nowMs: NOW,
    });
    expect(zombies).toHaveLength(1);
    expect(zombies[0]).toMatchObject({
      run_id: "run-1",
      lictor_pid: 4242,
      status: "completed",
      lingering_ms: 60 * 60_000,
    });
  });

  it("flags failed runs too (the 2026-09-05 case was a rejected completion)", () => {
    const zombies = findZombieRuns({
      runs: [run({ status: "failed", error: "completed rejected: no completion evidence" })],
      findSession,
      processes: observedProcesses(),
      nowMs: NOW,
    });
    expect(zombies).toHaveLength(1);
    expect(zombies[0]?.status).toBe("failed");
  });

  it("ignores a run whose process already exited", () => {
    expect(
      findZombieRuns({ runs: [run({})], findSession, processes: [], nowMs: NOW }),
    ).toEqual([]);
  });

  it("ignores a reused PID whose process generation does not belong to the session", () => {
    expect(
      findZombieRuns({
        runs: [run({})],
        findSession,
        processes: observedProcesses(4242, PROCESS_AGE_SEC / 2),
        nowMs: NOW,
      }),
    ).toEqual([]);
  });

  it("ignores runs that are still unfinished even if stale finished_at data remains", () => {
    expect(
      findZombieRuns({
        runs: [run({ status: "running" })],
        findSession,
        processes: observedProcesses(),
        nowMs: NOW,
      }),
    ).toEqual([]);
  });

  it("respects the grace period so orderly shutdown is not mistaken for a zombie", () => {
    const justFinished = run({ finished_at: NOW - (DEFAULT_ZOMBIE_GRACE_MS - 1_000) });
    expect(
      findZombieRuns({ runs: [justFinished], findSession, processes: observedProcesses(), nowMs: NOW }),
    ).toEqual([]);
  });

  it("ignores runs with no child session or no recorded pid", () => {
    expect(
      findZombieRuns({ runs: [run({ child_session_id: null })], findSession, processes: observedProcesses(), nowMs: NOW }),
    ).toEqual([]);
    expect(
      findZombieRuns({ runs: [run({})], findSession: () => session(null), processes: observedProcesses(), nowMs: NOW }),
    ).toEqual([]);
    expect(
      findZombieRuns({ runs: [run({})], findSession: () => null, processes: observedProcesses(), nowMs: NOW }),
    ).toEqual([]);
  });
});

describe("reapZombieRuns", () => {
  it("stops each distinct zombie process once", async () => {
    const stop = vi.fn(async (): Promise<StopResult> => ({ ok: true, method: "taskkill" }));
    const zombies = findZombieRuns({
      runs: [run({}), run({ id: "run-2", child_session_id: "lictor-child" })],
      findSession: () => session(4242),
      processes: observedProcesses(),
      nowMs: NOW,
    });
    const results = await reapZombieRuns({ zombies, stop });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith(4242);
    expect(results.every((r) => r.stop.ok)).toBe(true);
  });

  it("reports a failed kill without throwing", async () => {
    const stop = vi.fn(async (): Promise<StopResult> => ({ ok: false, error: "access denied" }));
    const zombies = findZombieRuns({
      runs: [run({})],
      findSession: () => session(4242),
      processes: observedProcesses(),
      nowMs: NOW,
    });
    const results = await reapZombieRuns({ zombies, stop });
    expect(results[0]?.stop).toEqual({ ok: false, error: "access denied" });
  });
});

describe("scanFinishedRuns", () => {
  const runs = { listFinishedRunsWithChildSession: () => [run({})] };
  const sessions = { findSession: () => session(4242) };

  it("does nothing while disabled", async () => {
    const stop = vi.fn();
    const found = await scanFinishedRuns({
      runs,
      sessions,
      resolveEnabled: () => false,
      resolveAutoReap: () => true,
      scanProcesses: async () => observedProcesses(),
      nowMs: () => NOW,
      stop,
    });
    expect(found).toEqual([]);
    expect(stop).not.toHaveBeenCalled();
  });

  it("detects without killing when autoReap is off (the default)", async () => {
    const stop = vi.fn();
    const onZombies = vi.fn();
    const found = await scanFinishedRuns({
      runs,
      sessions,
      resolveEnabled: () => true,
      resolveAutoReap: () => false,
      scanProcesses: async () => observedProcesses(),
      nowMs: () => NOW,
      stop,
      onZombies,
    });
    expect(found).toHaveLength(1);
    expect(onZombies).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();
  });

  it("notifies onReaped only when it actually stopped something", async () => {
    const stop = vi.fn(async (): Promise<StopResult> => ({ ok: true, method: "taskkill" }));
    const onReaped = vi.fn();

    // 検出だけのときは呼ばない (掃除していないのに通知すると常時鳴り続ける)。
    await scanFinishedRuns({
      runs, sessions,
      resolveEnabled: () => true,
      resolveAutoReap: () => false,
      scanProcesses: async () => observedProcesses(),
      nowMs: () => NOW,
      stop,
      onReaped,
    });
    expect(onReaped).not.toHaveBeenCalled();

    await scanFinishedRuns({
      runs, sessions,
      resolveEnabled: () => true,
      resolveAutoReap: () => true,
      scanProcesses: async () => observedProcesses(),
      nowMs: () => NOW,
      stop,
      onReaped,
    });
    expect(onReaped).toHaveBeenCalledOnce();
    expect(onReaped.mock.calls[0]![0]).toHaveLength(1);
  });

  it("kills when autoReap is explicitly enabled", async () => {
    const stop = vi.fn(async (): Promise<StopResult> => ({ ok: true, method: "taskkill" }));
    const found = await scanFinishedRuns({
      runs,
      sessions,
      resolveEnabled: () => true,
      resolveAutoReap: () => true,
      scanProcesses: async () => observedProcesses(),
      nowMs: () => NOW,
      stop,
    });
    expect(found).toHaveLength(1);
    expect(stop).toHaveBeenCalledWith(4242);
  });

  it("revalidates process ownership immediately before killing", async () => {
    const stop = vi.fn(async (): Promise<StopResult> => ({ ok: true, method: "taskkill" }));
    const scanProcesses = vi.fn()
      .mockResolvedValueOnce(observedProcesses())
      .mockResolvedValueOnce([]);
    const found = await scanFinishedRuns({
      runs,
      sessions,
      resolveEnabled: () => true,
      resolveAutoReap: () => true,
      scanProcesses,
      nowMs: () => NOW,
      stop,
    });
    expect(found).toHaveLength(1);
    expect(scanProcesses).toHaveBeenCalledTimes(2);
    expect(stop).not.toHaveBeenCalled();
  });
});
