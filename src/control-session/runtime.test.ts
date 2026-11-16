import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestDb } from "../../tests/helpers/db.js";
import type { SessionRow } from "../shared/types.js";
import type { ControlChannelSurface } from "./channel-surface.js";
import { CONTROL_HOLDER_KEY } from "./holder-store.js";
import { CONTROL_SUMMARY_INTERVAL_MS, CONTROL_SUMMARY_POSTED_KEY } from "./hourly-summary.js";
import { createControlRuntime } from "./runtime.js";

function session(id: string, metadata: Record<string, unknown> = {}): SessionRow {
  return {
    id, provider: "claude-code", repo_path: `E:/${id}`, repo_origin: null, branch: "b", host: "h", started_at: 1,
    ended_at: null, status: "active", last_seen_at: 1, current_task: null, transcript_path: null,
    metadata: JSON.stringify(metadata), ws_clients: 1, target_project: null,
  } as SessionRow;
}

describe("control runtime wiring", () => {
  it("spawns from a prepared workspace, ensures the channel, dispatches bulk instructions and posts a notice", async () => {
    const root = await mkdtemp(join(tmpdir(), "cc-control-rt-"));
    try {
      const values = new Map<string, string>();
      let enabled = true;
      let active: SessionRow[] = [session("w1")];
      const spawns: Array<{ cwd: string; title: string; prompt: string }> = [];
      const enrolled: string[] = [];
      const emitted: Array<{ target_session_id: string; text: string }> = [];
      const posts: string[] = [];
      let ensured = 0;
      const runtime = createControlRuntime({
        db: makeTestDb(),
        settings: { get: (k) => values.get(k) ?? null, set: (k, v) => { values.set(k, v); }, delete: (k) => { values.delete(k); } },
        isEnabled: () => enabled,
        sessions: { findAllActive: () => active, findSession: (id) => active.find((s) => s.id === id) ?? null },
        projectOf: () => "Cc",
        latestStat: () => null,
        lastActivitySec: () => null,
        probes: {
          isAutoCheckDisabled: () => false, hasPendingQuestion: () => false, isHumanWaitActive: () => false,
          isWaitingForHumanResponse: () => false, isAwaitingAsk: async () => false,
        },
        inject: { canDeliver: () => true, emit: (event) => { emitted.push(event); } },
        injectToSession: () => true,
        spawn: async (input) => { expect(enrolled).toContain(input.spawnId); spawns.push(input); return { ok: true }; },
        enrollment: { record: ({ spawnId }) => { enrolled.push(spawnId); }, forget: (spawnId) => { enrolled.splice(enrolled.indexOf(spawnId), 1); } },
        workspaceRoot: () => root,
        concordiaUrl: "http://127.0.0.1:1",
        runOneShot: async () => ({ ok: true, stdout: "1 件動いています" }),
        log: { info: () => {}, warn: () => {} },
      });
      const surface: ControlChannelSurface = { ensure: async () => { ensured += 1; }, post: async (text) => { posts.push(text); } };
      runtime.attachChannel(surface);

      await runtime.tick();
      expect(spawns).toHaveLength(1);
      expect(spawns[0].cwd).toBe(join(root, ".concordia-control"));
      expect(spawns[0].prompt).toContain("CONTROL.md");
      expect(ensured).toBe(1);

      const spawnId = JSON.parse(values.get(CONTROL_HOLDER_KEY)!).spawn_id as string;
      active = [session("w1"), session("ctl", { concordia_spawn_id: spawnId })];
      await runtime.tick();
      expect(ensured).toBe(1);
      expect(runtime.isControlSession(active[1])).toBe(true);

      const reply = await runtime.handleChannelPost({ actorLabel: "neco", allowed: true, content: "一括: 状況を報告して" });
      expect(reply).toContain("届けた: 1 件");
      expect(emitted.map((e) => e.target_session_id)).toEqual(["w1"]);
      expect(posts.filter((p) => p.includes("[管制まとめ]"))).toHaveLength(1);
      expect(posts.find((p) => p.includes("neco の指示を届けました"))).toContain("neco の指示を届けました: w1");
      expect(await runtime.handleChannelPost({ actorLabel: "neco", allowed: true, content: "何が動いてる？" })).toBe("1 件動いています");

      expect(await runtime.api.dispatch({ targets: ["ctl"], text: "x", origin: { kind: "control", generation: 1 } }))
        .toEqual({ delivered: [], skipped: [{ session_id: "ctl", reason: "control_session" }] });

      enabled = false;
      await runtime.tick();
      expect(values.has(CONTROL_HOLDER_KEY)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("control runtime hourly summary", () => {
  it("posts once per hour while ON with a ready channel, retries after a failed post, and forgets the time when OFF", async () => {
    const root = await mkdtemp(join(tmpdir(), "cc-control-sum-"));
    try {
      const values = new Map<string, string>();
      let enabled = true;
      let nowMs = Date.UTC(2026, 10, 16, 3, 0, 0);
      const posts: string[] = [];
      let failNext = false;
      const runtime = createControlRuntime({
        db: makeTestDb(),
        settings: { get: (k) => values.get(k) ?? null, set: (k, v) => { values.set(k, v); }, delete: (k) => { values.delete(k); } },
        isEnabled: () => enabled,
        sessions: { findAllActive: () => [session("w1")], findSession: (id) => (id === "w1" ? session("w1") : null) },
        projectOf: () => "Cc",
        latestStat: () => null,
        lastActivitySec: () => null,
        probes: {
          isAutoCheckDisabled: () => false, hasPendingQuestion: () => false, isHumanWaitActive: () => false,
          isWaitingForHumanResponse: () => false, isAwaitingAsk: async () => false,
        },
        inject: { canDeliver: () => true, emit: () => {} },
        injectToSession: () => true,
        spawn: async () => ({ ok: true }),
        enrollment: { record: () => {}, forget: () => {} },
        workspaceRoot: () => root,
        concordiaUrl: "http://127.0.0.1:1",
        runOneShot: async () => ({ ok: true, stdout: "" }),
        now: () => nowMs,
        log: { info: () => {}, warn: () => {} },
      });
      runtime.attachChannel({
        ensure: async () => {},
        post: async (text) => {
          if (failNext) { failNext = false; throw new Error("discord down"); }
          posts.push(text);
        },
      });

      await runtime.tick();
      expect(posts).toHaveLength(1);
      expect(posts[0]).toContain("[管制まとめ] 2026-11-16 12:00 JST — 動いているセッション 1 件");
      expect(values.get(CONTROL_SUMMARY_POSTED_KEY)).toBe(String(nowMs));

      nowMs += 60 * 1000;
      await runtime.tick();
      expect(posts).toHaveLength(1);

      nowMs += CONTROL_SUMMARY_INTERVAL_MS;
      failNext = true;
      const before = values.get(CONTROL_SUMMARY_POSTED_KEY);
      await runtime.tick();
      expect(posts).toHaveLength(1);
      expect(values.get(CONTROL_SUMMARY_POSTED_KEY)).toBe(before);

      nowMs += 60 * 1000;
      await runtime.tick();
      expect(posts).toHaveLength(2);
      expect(values.get(CONTROL_SUMMARY_POSTED_KEY)).toBe(String(nowMs));

      enabled = false;
      await runtime.tick();
      expect(values.has(CONTROL_SUMMARY_POSTED_KEY)).toBe(false);
      expect(posts).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("control runtime spawn enrollment", () => {
  it("records the spawn enrollment before spawning and forgets it when the spawn fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "cc-control-enr-"));
    try {
      const values = new Map<string, string>();
      const events: string[] = [];
      const runtime = createControlRuntime({
        db: makeTestDb(),
        settings: { get: (k) => values.get(k) ?? null, set: (k, v) => { values.set(k, v); }, delete: (k) => { values.delete(k); } },
        isEnabled: () => true,
        sessions: { findAllActive: () => [], findSession: () => null },
        projectOf: () => "Cc",
        latestStat: () => null,
        lastActivitySec: () => null,
        probes: {
          isAutoCheckDisabled: () => false, hasPendingQuestion: () => false, isHumanWaitActive: () => false,
          isWaitingForHumanResponse: () => false, isAwaitingAsk: async () => false,
        },
        inject: { canDeliver: () => true, emit: () => {} },
        injectToSession: () => true,
        spawn: async ({ spawnId }) => { events.push(`spawn:${spawnId}`); return { ok: false, error: "wt.exe missing" }; },
        enrollment: {
          record: ({ spawnId, cwd }) => { events.push(`record:${spawnId}:${cwd === join(root, ".concordia-control")}`); },
          forget: (spawnId) => { events.push(`forget:${spawnId}`); },
        },
        workspaceRoot: () => root,
        concordiaUrl: "http://127.0.0.1:1",
        runOneShot: async () => ({ ok: true, stdout: "" }),
        log: { info: () => {}, warn: () => {} },
      });
      await runtime.tick();
      const spawnId = JSON.parse(values.get(CONTROL_HOLDER_KEY)!).spawn_id as string;
      expect(events).toEqual([`record:${spawnId}:true`, `spawn:${spawnId}`, `forget:${spawnId}`]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("control runtime child reaper wiring", () => {
  it("runs the child reaper only while the control session is ON", async () => {
    const root = await mkdtemp(join(tmpdir(), "cc-control-reap-"));
    try {
      const values = new Map<string, string>();
      let enabled = false;
      const nowMs = Date.UTC(2026, 10, 16, 8, 0, 0);
      const child = session("child", { delegation_parent_session_id: "parent" });
      const reaped: string[] = [];
      const runtime = createControlRuntime({
        db: makeTestDb(),
        settings: { get: (k) => values.get(k) ?? null, set: (k, v) => { values.set(k, v); }, delete: (k) => { values.delete(k); } },
        isEnabled: () => enabled,
        sessions: { findAllActive: () => [child], findSession: (id) => (id === "child" ? child : null) },
        projectOf: () => "Cc",
        latestStat: () => null,
        lastActivitySec: () => null,
        probes: {
          isAutoCheckDisabled: () => false, hasPendingQuestion: () => false, isHumanWaitActive: () => false,
          isWaitingForHumanResponse: () => false, isAwaitingAsk: async () => false,
        },
        inject: { canDeliver: () => true, emit: () => {} },
        injectToSession: () => true,
        spawn: async () => ({ ok: true }),
        enrollment: { record: () => {}, forget: () => {} },
        workspaceRoot: () => root,
        concordiaUrl: "http://127.0.0.1:1",
        runOneShot: async () => ({ ok: true, stdout: "" }),
        reaper: {
          isEnabled: () => true,
          findRun: () => null,
          isResidentChild: () => false,
          parentReceivedRunTerminal: () => false,
          lastActivitySec: () => Math.floor(nowMs / 1000) - 2 * 60 * 60,
          unchangedCount: () => 3,
          hasPendingQuestion: () => false,
          isHumanWaitActive: () => false,
          isWaitingForHumanResponse: () => false,
          isAwaitingAsk: async () => false,
          hasTestingClaim: () => false,
          listOpenLocalPrs: async () => [],
          findLocalPrByBranch: async () => null,
          git: async (_cwd, args) => ({ ok: true, stdout: args[0] === "rev-list" ? "0" : "" }),
          updateMetadata: () => {},
          inject: (sessionId) => { reaped.push(sessionId); return true; },
          endSession: async () => {},
        },
        now: () => nowMs,
        log: { info: () => {}, warn: () => {} },
      });
      await runtime.tick();
      expect(reaped).toEqual([]);
      enabled = true;
      await runtime.tick();
      expect(reaped).toEqual(["child", "parent"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
