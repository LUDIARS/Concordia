import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestDb } from "../../tests/helpers/db.js";
import type { SessionRow } from "../shared/types.js";
import type { ControlChannelSurface } from "./channel-surface.js";
import { CONTROL_HOLDER_KEY } from "./holder-store.js";
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
        spawn: async (input) => { spawns.push(input); return { ok: true }; },
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
      expect(posts[0]).toContain("neco の指示を届けました: w1");
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
