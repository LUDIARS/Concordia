import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { ManagementRepository } from "./repository.js";
import { ManagementError, ManagementService, type ManagementPorts } from "./service.js";

function setup(overrides: Partial<ManagementPorts> = {}) {
  const repo = new ManagementRepository(makeTestDb());
  let sequence = 0;
  let now = Date.UTC(2026, 9, 1, 3, 0, 0);
  const ports: ManagementPorts = {
    now: () => now,
    id: () => `id-${++sequence}`,
    newToken: () => `token-${++sequence}`,
    hashToken: (token) => `hash:${token}`,
    inject: vi.fn(),
    liveSessions: () => [],
    departmentExists: (id) => id === "dept-cdgd",
    ...overrides,
  };
  const service = new ManagementService(repo, ports);
  const { mission, token } = service.createMission({
    name: "CDGD", department_id: "dept-cdgd", project_codes: ["Cf"], goal: "試遊の意見を改善へつなぐ",
    allowed_kinds: ["discussion"], human_gate_kinds: ["spec_change"], requires_effect_check: true,
    max_open_requests: 2, daily_request_limit: 5,
  });
  const human = (key: string, target = "variant/1") => service.ingestEvent({
    event_key: key, source: "cf", kind: "comment", project_code: "Cf", target_key: target, origin: "human", summary: "操作が重い",
  }).event;
  const request = (key: string, seqs: number[], extra: Record<string, unknown> = {}) => service.submitRequest(
    service.authenticate(token),
    { request_key: key, kind: "discussion", project_code: "Cf", target_key: "variant/1", purpose: "原因を議論する",
      completion_criteria: "原因候補と次の試行が出る", evidence_seqs: seqs, rationale: "未議論の意見", ...extra },
  );
  return { repo, ports, service, mission, token, human, request, advance: (ms: number) => { now += ms; } };
}

function codeOf(fn: () => unknown): string {
  try { fn(); } catch (error) { return error instanceof ManagementError ? error.code : String(error); }
  return "no-error";
}

describe("missions (CC-MGMT-01)", () => {
  it("stores only the token hash and authenticates by it", () => {
    const { service, mission, token, repo } = setup();
    expect(repo.findMission(mission.id)?.token_hash).toBe(`hash:${token}`);
    expect(service.authenticate(token).id).toBe(mission.id);
    expect(codeOf(() => service.authenticate("wrong"))).toBe("unauthorized");
    expect(codeOf(() => service.authenticate(null))).toBe("unauthorized");
  });

  it("invalidates the old token on rotation", () => {
    const { service, mission, token } = setup();
    const rotated = service.rotateToken(mission.id);
    expect(codeOf(() => service.authenticate(token))).toBe("unauthorized");
    expect(service.authenticate(rotated.token).id).toBe(mission.id);
  });

  it("rejects an unknown department", () => {
    const { service } = setup();
    expect(codeOf(() => service.createMission({ name: "x", department_id: "nope", project_codes: ["Cf"], goal: "g", allowed_kinds: ["a1"] })))
      .toBe("department_not_found");
  });
});

describe("events and changes (CC-MGMT-02)", () => {
  it("is idempotent per event_key and rejects a changed payload", () => {
    const { service } = setup();
    const body = { event_key: "cf:c1", source: "cf", kind: "comment", project_code: "Cf", origin: "human", summary: "a" };
    expect(service.ingestEvent(body).created).toBe(true);
    expect(service.ingestEvent(body).created).toBe(false);
    expect(codeOf(() => service.ingestEvent({ ...body, summary: "b" }))).toBe("event_key_conflict");
    expect(codeOf(() => service.ingestEvent({ ...body, event_key: "x", source: "cc" }))).toBe("reserved_source");
  });

  it("returns only the mission's projects and reports sources", () => {
    const { service, mission, human } = setup();
    human("c1");
    service.ingestEvent({ event_key: "kd", source: "cf", kind: "comment", project_code: "KD", origin: "human", summary: "x" });
    const changes = service.changes(service.repo.findMission(mission.id)!, null, 100);
    expect(changes.events.map((e) => e.project_code)).toEqual(["Cf"]);
    expect(changes.sources.map((s) => s.source)).toEqual(["cf"]);
  });
});

describe("requests (CC-MGMT-04)", () => {
  it("accepts once per request_key and conflicts on changed content", () => {
    const { request, human } = setup();
    const seq = human("c1").seq;
    const first = request("r1", [seq]);
    expect(first).toMatchObject({ created: true, request: { state: "queued" } });
    expect(request("r1", [seq]).request.id).toBe(first.request.id);
    expect(codeOf(() => request("r1", [seq], { purpose: "別の目的" }))).toBe("request_key_conflict");
  });

  it("attaches a second request on the same target and injects into a dispatched assignee", () => {
    const { request, human, repo, ports } = setup();
    const parent = request("r1", [human("c1").seq]).request;
    repo.transition(parent, { state: "dispatched", session_id: "sess-1" }, 1);
    const child = request("r2", [human("c2").seq]).request;
    expect(child).toMatchObject({ state: "attached", attached_to: parent.id, session_id: "sess-1" });
    expect(ports.inject).toHaveBeenCalledWith("sess-1", expect.stringContaining("r2"));
  });

  it("refuses AI-only evidence and records a decision for accepted requests", () => {
    const { service, request, mission } = setup();
    const ai = service.ingestEvent({ event_key: "ai1", source: "cf", kind: "reply", project_code: "Cf", origin: "ai", summary: "AI 返信" }).event;
    expect(codeOf(() => request("r1", [ai.seq]))).toBe("evidence_ai_only");
    expect(service.repo.recentDecisions(mission.id, 10)).toHaveLength(0);
  });

  it("holds gated kinds for a human and never releases them automatically", () => {
    const { request, human, service } = setup();
    const row = request("r1", [human("c1").seq], { kind: "spec_change" }).request;
    expect(row.state).toBe("waiting_human");
    expect(codeOf(() => service.humanAction(row.id, "accept", { actor: "neco" }))).toBe("invalid_state");
    expect(service.humanAction(row.id, "approve", { actor: "neco" }).state).toBe("queued");
  });

  it("stops accepting after the mission is stopped but keeps existing requests", () => {
    const { request, human, service, mission } = setup();
    const row = request("r1", [human("c1").seq]).request;
    service.setMissionStatus(mission.id, "stopped");
    expect(codeOf(() => request("r2", [human("c2", "variant/2").seq]))).toBe("mission_stopped");
    expect(service.repo.findRequest(row.id)?.state).toBe("queued");
  });

  it("enforces the concurrent limit", () => {
    const { request, human } = setup();
    request("r1", [human("c1", "t1").seq], { target_key: "t1" });
    request("r2", [human("c2", "t2").seq], { target_key: "t2" });
    expect(codeOf(() => request("r3", [human("c3", "t3").seq], { target_key: "t3" }))).toBe("limit_open_requests");
  });
});

describe("decisions and acknowledgement (CC-MGMT-INV-04)", () => {
  it("only advances over events covered by a decision or request", () => {
    const { service, token, human, request } = setup();
    const mission = service.authenticate(token);
    const a = human("c1").seq;
    const b = human("c2").seq;
    expect(codeOf(() => service.acknowledge(mission, { seq: b }))).toBe("undecided_changes");
    service.recordDecision(mission, { decision_key: "d1", verdict: "wait", evidence_seqs: [a], rationale: "様子見" });
    expect(service.acknowledge(mission, { seq: a }).acknowledged_seq).toBe(a);
    request("r1", [b]);
    expect(service.acknowledge(mission, { seq: b }).acknowledged_seq).toBe(b);
    expect(service.acknowledge(mission, { seq: a }).acknowledged_seq).toBe(b);
  });

  it("does not require decisions for Cc's own lifecycle events", () => {
    const { service, token, human, request } = setup();
    const mission = service.authenticate(token);
    const seq = human("c1").seq;
    request("r1", [seq]);
    const changes = service.changes(mission, null, 100);
    expect(changes.events.some((e) => e.source === "cc" && e.origin === "system")).toBe(true);
    expect(service.acknowledge(mission, { seq: changes.next_after }).acknowledged_seq).toBe(changes.next_after);
  });
});

describe("human card deliveries (CC-MGMT-06)", () => {
  it("returns cards only for states that need a human and records the delivered revision", () => {
    const { service, request, human } = setup();
    const queued = request("r1", [human("c1").seq]).request;
    const gated = request("r2", [human("c2", "variant/2").seq], { kind: "spec_change", target_key: "variant/2" }).request;
    const first = service.deliveries();
    expect(first.map((d) => d.request.id)).toEqual([gated.id]);
    expect(first[0]?.actions).toEqual(["approve", "reject"]);
    expect(service.repo.findRequest(queued.id)?.delivered_revision).toBe(queued.revision);
    service.recordDelivery(gated.id, { revision: gated.revision, message_id: "123" });
    expect(service.deliveries()).toEqual([]);
    service.humanAction(gated.id, "approve", { actor: "discord:1" });
    const edited = service.deliveries();
    expect(edited.map((d) => [d.request.id, d.request.discord_message_id, d.actions])).toEqual([[gated.id, "123", []]]);
  });

  it("never moves the delivered revision backwards", () => {
    const { service, request, human } = setup();
    const row = request("r1", [human("c1").seq], { kind: "spec_change" }).request;
    service.recordDelivery(row.id, { revision: 3, message_id: "9" });
    expect(service.recordDelivery(row.id, { revision: 1 }).delivered_revision).toBe(3);
  });
});

describe("outcome and acceptance (CC-MGMT-05)", () => {
  it("lets only the assignee record an outcome and only a human accept it", () => {
    const { request, human, repo, service } = setup();
    const row = request("r1", [human("c1").seq]).request;
    const dispatched = repo.transition(row, { state: "dispatched", session_id: "sess-1" }, 1)!;
    expect(codeOf(() => service.recordOutcome(dispatched.id, { session_id: "other", summary: "x" }))).toBe("not_assignee");
    const recorded = service.recordOutcome(dispatched.id, { session_id: "sess-1", summary: "議論した", refs: ["di:42"] });
    expect(recorded).toMatchObject({ state: "outcome_recorded", outcome_refs: ["di:42"] });
    expect(service.humanAction(recorded.id, "accept", { actor: "neco" }).state).toBe("accepted");
    expect(service.humanAction(recorded.id, "effect_confirmed", { actor: "neco", note: "試遊で解消" }).state).toBe("effect_confirmed");
  });
});
