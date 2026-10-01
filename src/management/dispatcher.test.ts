import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { ManagementDispatcher, type DispatchPorts } from "./dispatcher.js";
import { LAUNCH_CONFIRM_WINDOW_MS } from "./domain.js";
import { ManagementRepository } from "./repository.js";
import { ManagementService } from "./service.js";

function setup(overrides: Partial<DispatchPorts> = {}) {
  const repo = new ManagementRepository(makeTestDb());
  let sequence = 0;
  let now = 1_000_000;
  const service = new ManagementService(repo, {
    now: () => now, id: () => `id-${++sequence}`, newToken: () => `t-${++sequence}`, hashToken: (t) => `h:${t}`,
    inject: vi.fn(), liveSessions: () => [], departmentExists: () => true,
  });
  const { token } = service.createMission({
    name: "CDGD", project_codes: ["Cf"], goal: "g", allowed_kinds: ["discussion"], max_open_requests: 5,
  });
  const mission = service.authenticate(token);
  const seq = service.ingestEvent({ event_key: "c1", source: "cf", kind: "comment", project_code: "Cf", origin: "human", summary: "s" }).event.seq;
  const request = service.submitRequest(mission, {
    request_key: "r1", kind: "discussion", project_code: "Cf", target_key: "variant/1",
    purpose: "p", completion_criteria: "c", evidence_seqs: [seq], rationale: "r",
  }).request;
  const sessions = new Map<string, { id: string; ended: boolean }>();
  const ports: DispatchPorts = {
    now: () => now,
    id: () => `spawn-${++sequence}`,
    isBlocked: () => false,
    launch: vi.fn(async () => ({ ok: true as const })),
    findSessionBySpawnId: (spawnId) => sessions.get(spawnId) ?? null,
    isSessionEnded: (id) => [...sessions.values()].find((s) => s.id === id)?.ended ?? null,
    logError: vi.fn(),
    ...overrides,
  };
  const dispatcher = new ManagementDispatcher(service, ports);
  return { repo, service, mission, request, ports, dispatcher, sessions, advance: (ms: number) => { now += ms; } };
}

describe("ManagementDispatcher (CC-MGMT-04)", () => {
  it("persists the spawn id before launching and confirms the session by it", async () => {
    const { dispatcher, repo, request, ports, sessions } = setup();
    dispatcher.tick();
    dispatcher.tick();
    await dispatcher.stop();
    expect(ports.launch).toHaveBeenCalledTimes(1);
    const launching = repo.findRequest(request.id)!;
    expect(launching.state).toBe("launching");
    expect(launching.spawn_id).toBeTruthy();
    sessions.set(launching.spawn_id!, { id: "sess-9", ended: false });
    dispatcher.reconcileLaunches();
    expect(repo.findRequest(request.id)).toMatchObject({ state: "dispatched", session_id: "sess-9" });
  });

  it("treats a thrown launch as unknown and keeps the same spawn id (CC-MGMT-INV-03)", async () => {
    const { dispatcher, repo, request, sessions } = setup({ launch: vi.fn(async () => { throw new Error("lost ack"); }) });
    dispatcher.tick();
    await dispatcher.stop();
    const unknown = repo.findRequest(request.id)!;
    expect(unknown.state).toBe("launch_unknown");
    sessions.set(unknown.spawn_id!, { id: "sess-late", ended: false });
    dispatcher.reconcileLaunches();
    expect(repo.findRequest(request.id)).toMatchObject({ state: "dispatched", spawn_id: unknown.spawn_id });
  });

  it("fails only after the confirmation window passes without a session", async () => {
    const { dispatcher, repo, request, advance } = setup();
    dispatcher.tick();
    await dispatcher.stop();
    dispatcher.reconcileLaunches();
    expect(repo.findRequest(request.id)!.state).toBe("launching");
    advance(LAUNCH_CONFIRM_WINDOW_MS + 1);
    dispatcher.reconcileLaunches();
    expect(repo.findRequest(request.id)!.state).toBe("launch_failed");
  });

  it("records a known launch failure without retrying", async () => {
    const launch = vi.fn(async () => ({ ok: false as const, error: "no checkout" }));
    const { dispatcher, repo, request } = setup({ launch });
    dispatcher.tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    dispatcher.tick();
    await dispatcher.stop();
    expect(launch).toHaveBeenCalledTimes(1);
    expect(repo.findRequest(request.id)).toMatchObject({ state: "launch_failed", error: "no checkout" });
  });

  it("holds queued requests while cost is blocked or the mission is stopped", async () => {
    const blocked = setup({ isBlocked: () => true });
    blocked.dispatcher.tick();
    await blocked.dispatcher.stop();
    expect(blocked.ports.launch).not.toHaveBeenCalled();

    const stopped = setup();
    stopped.service.setMissionStatus(stopped.mission.id, "stopped");
    stopped.dispatcher.tick();
    await stopped.dispatcher.stop();
    expect(stopped.ports.launch).not.toHaveBeenCalled();
    expect(stopped.repo.findRequest(stopped.request.id)!.state).toBe("queued");
  });

  it("marks execution_finished when the assignee ends, without calling it accepted", () => {
    const { dispatcher, repo, request, sessions } = setup();
    repo.transition(request, { state: "dispatched", session_id: "sess-1" }, 1);
    sessions.set("x", { id: "sess-1", ended: true });
    dispatcher.observeFinished();
    expect(repo.findRequest(request.id)!.state).toBe("execution_finished");
  });
});
