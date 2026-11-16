import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import type { SessionRow } from "../shared/types.js";
import { ControlBoardRepo } from "./board-repo.js";
import { ControlHolderStore } from "./holder-store.js";
import type { EligibilityProbes } from "./instruction-eligibility.js";
import { CONTROL_SPAWN_GRACE_MS } from "./singleton-policy.js";
import { CONTROL_DIGEST_SENTINEL } from "./stall-digest.js";
import { CONTROL_RETIRE_NOTICE, createControlSupervisor, type ControlSupervisorDeps } from "./supervisor.js";

function session(id: string, metadata: Record<string, unknown> = {}): SessionRow {
  return {
    id, provider: "claude-code", repo_path: `E:/${id}`, repo_origin: null, branch: "feat/x", host: "h", started_at: 1,
    ended_at: null, status: "active", last_seen_at: 1, current_task: `task ${id}`, transcript_path: null,
    metadata: JSON.stringify(metadata), ws_clients: 1, target_project: null,
  } as SessionRow;
}

function stalled(id: string, fingerprint = `{"state":"task-active","id":"${id}"}`): SessionRow {
  return session(id, { cc_followup_progress: { fingerprint, unchanged_count: 2, last_checked_at: 1, last_changed_at: 1 } });
}

function harness(initial: SessionRow[], patch: Partial<ControlSupervisorDeps> = {}) {
  const values = new Map<string, string>();
  const settings = { get: (k: string) => values.get(k) ?? null, set: (k: string, v: string) => { values.set(k, v); }, delete: (k: string) => { values.delete(k); } };
  let active = [...initial];
  let now = 10_000_000;
  let enabled = true;
  let spawnSeq = 0;
  const spawned: Array<{ spawnId: string; generation: number }> = [];
  const injected: Array<{ sessionId: string; text: string }> = [];
  const probes: EligibilityProbes = {
    isControlSession: () => false, isAutoCheckDisabled: () => false, hasPendingQuestion: () => false,
    isHumanWaitActive: () => false, isWaitingForHumanResponse: () => false, isAwaitingAsk: async () => false,
  };
  const board = new ControlBoardRepo(makeTestDb());
  const holders = new ControlHolderStore(settings);
  const supervisor = createControlSupervisor({
    isEnabled: () => enabled,
    sessions: { findAllActive: () => active },
    holders, board,
    projectOf: () => "Cc",
    latestStat: () => null,
    lastActivitySec: () => 5,
    newSpawnId: () => `spawn-${++spawnSeq}`,
    spawnControl: async (input) => { spawned.push(input); return { ok: true }; },
    injectToControl: (sessionId, text) => { injected.push({ sessionId, text }); return true; },
    probes,
    now: () => now,
    log: { info: () => {}, warn: () => {} },
    ...patch,
  });
  return {
    supervisor, board, holders, spawned, injected,
    setActive: (rows: SessionRow[]) => { active = rows; },
    advance: (ms: number) => { now += ms; },
    disable: () => { enabled = false; },
  };
}

describe("control supervisor", () => {
  it("spawns one control session, waits during the grace and keeps the registered one (CC-CTL-INV-01)", async () => {
    const h = harness([session("worker")]);
    expect((await h.supervisor.runOnce()).spawned).toBe(true);
    expect(h.spawned).toEqual([{ spawnId: "spawn-1", generation: 1 }]);
    // 登録前に次の巡回が来ても重ねて起動しない。
    await h.supervisor.runOnce();
    expect(h.spawned).toHaveLength(1);
    h.setActive([session("worker"), session("ctl", { concordia_spawn_id: "spawn-1" })]);
    const report = await h.supervisor.runOnce();
    expect(report.controlSessionId).toBe("ctl");
    expect(h.supervisor.currentControlSessionId()).toBe("ctl");
    expect(h.supervisor.isControlSession(session("ctl", { concordia_spawn_id: "spawn-1" }))).toBe(true);
  });

  it("rebuilds with a new generation after the control session ends and tells the old one to stop", async () => {
    const h = harness([session("ctl", { concordia_spawn_id: "spawn-1" })]);
    await h.supervisor.runOnce();
    h.setActive([]);
    h.advance(CONTROL_SPAWN_GRACE_MS);
    await h.supervisor.runOnce();
    expect(h.spawned.map((s) => s.generation)).toEqual([1, 2]);
    // 退役世代が生き残っていたら 1 回だけ終了を促す。
    h.setActive([session("old", { concordia_spawn_id: "spawn-1" })]);
    await h.supervisor.runOnce();
    await h.supervisor.runOnce();
    expect(h.injected.filter((i) => i.text === CONTROL_RETIRE_NOTICE)).toEqual([{ sessionId: "old", text: CONTROL_RETIRE_NOTICE }]);
  });

  it("overwrites one board row per worker and excludes the control session itself (CC-CTL-INV-02)", async () => {
    const h = harness([session("a"), session("b")]);
    await h.supervisor.runOnce();
    h.setActive([session("b"), session("ctl", { concordia_spawn_id: "spawn-1" })]);
    await h.supervisor.runOnce();
    expect(h.board.list().map((r) => r.session_id)).toEqual(["b"]);
  });

  it("sends a digest of stalled sessions once per fingerprint (CC-CTL-INV-04)", async () => {
    const h = harness([stalled("w1"), session("w2"), session("ctl", { concordia_spawn_id: "spawn-1" })]);
    h.holders.write({ spawn_id: "spawn-1", generation: 1, spawned_at: 0, retired: [] });
    expect((await h.supervisor.runOnce()).digested).toEqual(["w1"]);
    expect(h.injected[0].sessionId).toBe("ctl");
    expect(h.injected[0].text.startsWith(CONTROL_DIGEST_SENTINEL)).toBe(true);
    expect((await h.supervisor.runOnce()).digested).toEqual([]);
    h.setActive([stalled("w1", '{"state":"review-wait"}'), session("ctl", { concordia_spawn_id: "spawn-1" })]);
    expect((await h.supervisor.runOnce()).digested).toEqual(["w1"]);
  });

  it("does not report stalled sessions that wait for a human (CC-CTL-INV-05)", async () => {
    const h = harness([stalled("w1"), session("ctl", { concordia_spawn_id: "spawn-1" })], {
      probes: {
        isControlSession: () => false, isAutoCheckDisabled: () => false, hasPendingQuestion: () => true,
        isHumanWaitActive: () => false, isWaitingForHumanResponse: () => false, isAwaitingAsk: async () => false,
      },
    });
    h.holders.write({ spawn_id: "spawn-1", generation: 1, spawned_at: 0, retired: [] });
    expect((await h.supervisor.runOnce()).digested).toEqual([]);
    expect(h.injected).toEqual([]);
  });

  it("asks the control session to stop and clears the holder when disabled", async () => {
    const h = harness([session("w"), session("ctl", { concordia_spawn_id: "spawn-1" })]);
    h.holders.write({ spawn_id: "spawn-1", generation: 1, spawned_at: 0, retired: [] });
    await h.supervisor.runOnce();
    h.disable();
    expect((await h.supervisor.runOnce()).enabled).toBe(false);
    expect(h.injected.at(-1)).toEqual({ sessionId: "ctl", text: CONTROL_RETIRE_NOTICE });
    expect(h.holders.read()).toBeNull();
    expect(h.board.list()).toEqual([]);
    await h.supervisor.runOnce();
    expect(h.injected.filter((i) => i.text === CONTROL_RETIRE_NOTICE)).toHaveLength(1);
    expect(h.spawned).toEqual([]);
  });

  it("keeps the spawn intent when the spawn fails so it retries only after the grace", async () => {
    const h = harness([], { spawnControl: async () => ({ ok: false, error: "no lictor" }) });
    expect((await h.supervisor.runOnce()).spawned).toBe(false);
    expect(h.holders.read()?.generation).toBe(1);
    await h.supervisor.runOnce();
    expect(h.holders.read()?.generation).toBe(1);
  });
});
