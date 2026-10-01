import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { createManagementRuntime, hashManagementToken, type ManagementRuntime } from "./runtime.js";

vi.mock("../control/spawner.js", () => ({ spawnSession: vi.fn(() => ({ ok: true, command: [], pid: 1 })) }));

const runtimes: ManagementRuntime[] = [];
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.stop(); });

function setup() {
  const db = makeTestDb();
  const runtime = createManagementRuntime({
    db,
    concordiaUrl: "http://127.0.0.1:11111",
    isBlocked: () => false,
    projectByCode: (code) => (code === "Cf" ? { project: "Conflux", repo_path: "E:/Document/Ars/Conflux" } : null),
    departmentExists: () => true,
    writePrompt: vi.fn(async () => "/tmp/prompt.md"),
  });
  runtimes.push(runtime);
  return { db, runtime };
}

describe("management runtime", () => {
  it("hashes tokens deterministically without keeping the plain value", () => {
    expect(hashManagementToken("abc")).toBe(hashManagementToken("abc"));
    expect(hashManagementToken("abc")).not.toContain("abc");
    expect(hashManagementToken("abc")).toHaveLength(64);
  });

  it("issues prefixed tokens that authenticate the created mission", () => {
    const { runtime } = setup();
    const { mission, token } = runtime.service.createMission({ name: "CDGD", project_codes: ["Cf"], goal: "g", allowed_kinds: ["discussion"] });
    expect(token).toMatch(/^ccm_/);
    expect(runtime.service.authenticate(token).id).toBe(mission.id);
  });

  it("confirms a launch by the spawn id stored in session metadata", () => {
    const { db, runtime } = setup();
    db.prepare(`INSERT INTO sessions (id, provider, repo_path, host, started_at, status, last_seen_at, metadata)
      VALUES ('sess-1', 'claude-code', 'E:/Document/Ars/Conflux', 'h', 1, 'active', 1, ?)`)
      .run(JSON.stringify({ concordia_spawn_id: "spawn-abc" }));
    const { token } = runtime.service.createMission({ name: "CDGD", project_codes: ["Cf"], goal: "g", allowed_kinds: ["discussion"] });
    const mission = runtime.service.authenticate(token);
    const seq = runtime.service.ingestEvent({ event_key: "c1", source: "cf", kind: "comment", project_code: "Cf", origin: "human", summary: "s" }).event.seq;
    const { request } = runtime.service.submitRequest(mission, {
      request_key: "r1", kind: "discussion", project_code: "Cf", target_key: "variant/1",
      purpose: "p", completion_criteria: "c", evidence_seqs: [seq], rationale: "r",
    });
    runtime.service.repo.transition(request, { state: "launching", spawn_id: "spawn-abc", launch_deadline_at: Date.now() + 60_000 }, 2);
    runtime.dispatcher.reconcileLaunches();
    expect(runtime.service.repo.findRequest(request.id)).toMatchObject({ state: "dispatched", session_id: "sess-1" });
    expect(runtime.service.context(mission).live_sessions.map((s) => s.id)).toEqual(["sess-1"]);
  });
});
