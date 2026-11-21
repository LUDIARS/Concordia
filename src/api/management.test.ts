import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { CircuitBreakerRepository } from "../management/circuit-breaker-repo.js";
import { CircuitBreakerService } from "../management/circuit-breaker-service.js";
import { ManagementRepository } from "../management/repository.js";
import { ManagementService } from "../management/service.js";
import { managementAdminRouter, managementRemoteApp, managementRouter } from "./management.js";

function setup() {
  let sequence = 0;
  const db = makeTestDb();
  const repo = new ManagementRepository(db);
  const breaker = new CircuitBreakerService(new CircuitBreakerRepository(db), {
    now: () => 1_000, isCostBlocked: () => false, countManagedRuns: () => repo.countRunning(),
    postAlert: async () => false, sessionLink: () => null,
  });
  const service = new ManagementService(repo, {
    now: () => 1_000, id: () => `id-${++sequence}`, newToken: () => `tok-${++sequence}`, hashToken: (t) => `h:${t}`,
    inject: vi.fn(), liveSessions: () => [], departmentExists: () => true,
  }, breaker);
  const app = new Hono();
  app.route("/v1/management", managementRouter(service));
  app.route("/v1/admin/management", managementAdminRouter(service));
  const call = (method: string, path: string, body?: unknown, token?: string) => app.request(path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { app, call, service, breaker };
}

async function createMission(call: ReturnType<typeof setup>["call"], overrides: Record<string, unknown> = {}) {
  const res = await call("POST", "/v1/admin/management/missions", {
    name: "CDGD", project_codes: ["Cf"], goal: "g", allowed_kinds: ["discussion"], ...overrides,
  });
  expect(res.status).toBe(201);
  return await res.json() as { mission: Record<string, unknown>; token: string };
}

describe("management HTTP", () => {
  it("returns the token once and never exposes its hash", async () => {
    const { call } = setup();
    const created = await createMission(call);
    expect(created.token).toMatch(/^tok-/);
    expect(created.mission).not.toHaveProperty("token_hash");
    const list = await (await call("GET", "/v1/admin/management/missions")).json() as { missions: Array<Record<string, unknown>> };
    expect(list.missions[0]).not.toHaveProperty("token_hash");
  });

  it("requires the mission token for dots operations", async () => {
    const { call } = setup();
    const { token } = await createMission(call);
    expect((await call("GET", "/v1/management/context")).status).toBe(401);
    expect((await call("GET", "/v1/management/context", undefined, "bad")).status).toBe(401);
    expect((await call("GET", "/v1/management/context", undefined, token)).status).toBe(200);
  });

  it("runs ingest → request → outcome → human accept end to end", async () => {
    const { call, service } = setup();
    const { token } = await createMission(call);
    const ingested = await call("POST", "/v1/management/events", {
      event_key: "cf:c1", source: "cf", kind: "comment", project_code: "Cf", target_key: "variant/1", origin: "human", summary: "重い",
    });
    expect(ingested.status).toBe(201);
    const seq = ((await ingested.json()) as { event: { seq: number } }).event.seq;
    const body = { request_key: "r1", kind: "discussion", project_code: "Cf", target_key: "variant/1",
      purpose: "p", completion_criteria: "c", evidence_seqs: [seq], rationale: "r" };
    const submitted = await call("POST", "/v1/management/requests", body, token);
    expect(submitted.status).toBe(201);
    expect((await call("POST", "/v1/management/requests", body, token)).status).toBe(200);
    const { request } = await submitted.json() as { request: { id: string } };
    const row = service.repo.findRequest(request.id)!;
    service.repo.transition(row, { state: "dispatched", session_id: "sess-1" }, 2);
    const outcome = await call("POST", `/v1/management/requests/${request.id}/outcome`, { session_id: "sess-1", summary: "済み" });
    expect(outcome.status).toBe(200);
    const accepted = await call("POST", `/v1/admin/management/requests/${request.id}/accept`, { actor: "neco" });
    expect(((await accepted.json()) as { request: { state: string } }).request.state).toBe("accepted");
    const lookup = await call("GET", "/v1/management/requests/r1", undefined, token);
    expect(((await lookup.json()) as { request: { state: string } }).request.state).toBe("accepted");
  });

  it("maps input and state errors to 400 / 409 and unknown actions to 404", async () => {
    const { call } = setup();
    const { token } = await createMission(call);
    expect((await call("POST", "/v1/management/requests", { request_key: "" }, token)).status).toBe(400);
    expect((await call("POST", "/v1/management/acknowledge", { seq: 5 }, token)).status).toBe(200);
    expect((await call("POST", "/v1/admin/management/requests/x/delete", { actor: "neco" })).status).toBe(404);
    expect((await call("POST", "/v1/admin/management/requests/x/accept", { actor: "neco" })).status).toBe(404);
  });

  it("scopes Bearer evaluation to enabled missions and records the actor and visible evidence", async () => {
    const { call, service, breaker } = setup();
    const { token, mission } = await createMission(call, { requires_effect_check: true, human_gate_kinds: ["spec_change"] });
    const other = await createMission(call, { autonomous_evaluation: true });
    const seq = service.ingestEvent({ event_key: "ai", source: "cf", kind: "comment", project_code: "Cf", origin: "ai", summary: "s" }).event.seq;
    const foreign = service.ingestEvent({ event_key: "other", source: "cf", kind: "comment", project_code: "Di", origin: "human", summary: "s" }).event.seq;
    const submit = (body: Record<string, unknown>) => call("POST", "/v1/management/requests", {
      request_key: "r1", kind: "discussion", project_code: "Cf", target_key: "variant/1",
      purpose: "p", completion_criteria: "c", evidence_seqs: [seq], rationale: "r", ...body,
    }, token);
    expect(mission).toMatchObject({ allow_ai_only_evidence: false, autonomous_evaluation: false });
    expect(await (await submit({})).json()).toMatchObject({ error: "evidence_ai_only" });
    await call("PATCH", `/v1/admin/management/missions/${mission.id as string}`, { allow_ai_only_evidence: true });
    const submitted = await submit({});
    expect(submitted.status).toBe(201);
    const { request: { id } } = await submitted.json() as { request: { id: string } };
    const evaluation = (key: string, action: string, auth?: string, evidence?: number[]) => call("POST",
      `/v1/management/requests/${key}/evaluate`, { action, evidence_seqs: evidence }, auth);
    expect((await evaluation("r1", "accept")).status).toBe(401);
    expect((await evaluation(id, "accept", other.token)).status).toBe(404);
    expect((await evaluation("r1", "accept", token)).status).toBe(403);

    await call("PATCH", `/v1/admin/management/missions/${mission.id as string}`, { autonomous_evaluation: true });
    expect((await evaluation("r1", "accept", token)).status).toBe(409);
    const gated = await submit({ request_key: "gated", kind: "spec_change" });
    expect(await gated.json()).toMatchObject({ request: { state: "waiting_human" } });
    expect((await evaluation("gated", "accept", token)).status).toBe(403);
    expect((await evaluation("gated", "approve", token)).status).toBe(400);

    service.repo.transition(service.repo.findRequest(id)!, { state: "dispatched", session_id: "sess-1" }, 2);
    await call("POST", `/v1/management/requests/${id}/outcome`, { session_id: "sess-1", summary: "done" });
    expect(service.deliveries().map((item) => item.request.state)).toEqual(["waiting_human"]);
    breaker.recordFailure({ project_code: "Cf", target_key: "variant/1", session_id: "sess-1" });
    const accepted = await evaluation("r1", "accept", token);
    expect(await accepted.json()).toMatchObject({ request: { state: "accepted", human_note: "[ai:dots] accept" } });
    expect(breaker.snapshot().consecutive_failures).toBe(1);
    expect((await evaluation("r1", "effect_confirmed", token)).status).toBe(400);
    expect((await evaluation("r1", "effect_confirmed", token, [foreign])).status).toBe(409);
    const effect = await evaluation("r1", "effect_confirmed", token, [seq]);
    expect(await effect.json()).toMatchObject({ request: { state: "effect_confirmed", human_note: expect.stringContaining("[ai:dots] effect_confirmed (evidence_seqs=1)") } });
    expect(service.changes(service.authenticate(token), 0, 100).events).toContainEqual(expect.objectContaining({
      kind: "request_effect_confirmed", origin: "ai", parent_request_id: id,
    }));
    expect(breaker.snapshot().consecutive_failures).toBe(0);

    const second = await submit({ request_key: "r2", target_key: "variant/2" });
    const secondId = ((await second.json()) as { request: { id: string } }).request.id;
    service.repo.transition(service.repo.findRequest(secondId)!, { state: "dispatched", session_id: "sess-2" }, 2);
    await call("POST", `/v1/management/requests/${secondId}/outcome`, { session_id: "sess-2", summary: "done" });
    await evaluation("r2", "accept", token);
    breaker.configure({ consecutive_failures: 1 });
    expect((await evaluation("r2", "effect_not_met", token, [seq])).status).toBe(200);
    expect(breaker.snapshot()).toMatchObject({ status: "OPEN", reason: "consecutive_failures", target: { session_id: "sess-2" } });
  });

  it("serves card deliveries and request actions to the human surfaces", async () => {
    const { call } = setup();
    await createMission(call);
    const missions = await (await call("GET", "/v1/admin/management/missions")).json() as { missions: Array<{ id: string }> };
    expect(missions.missions).toHaveLength(1);
    const deliveries = await (await call("GET", "/v1/admin/management/deliveries")).json() as { deliveries: unknown[] };
    expect(deliveries.deliveries).toEqual([]);
    expect((await call("POST", "/v1/admin/management/requests/missing/delivery", { revision: 1 })).status).toBe(404);
    const requests = await (await call("GET", "/v1/admin/management/requests")).json() as { requests: unknown[] };
    expect(requests.requests).toEqual([]);
  });

  it("refuses new requests after stop but keeps reads", async () => {
    const { call } = setup();
    const { token, mission } = await createMission(call);
    await call("POST", `/v1/admin/management/missions/${mission.id as string}/stop`);
    expect((await call("GET", "/v1/management/context", undefined, token)).status).toBe(200);
    expect((await call("POST", "/v1/management/decisions", {
      decision_key: "d", verdict: "wait", evidence_seqs: [1], rationale: "r",
    }, token)).status).toBe(403);
  });
});

describe("dots remote app (CC-MGMT-07 / CC-MGMT-INV-08)", () => {
  function remote(limitAfter = 5) {
    const { service, call } = setup();
    let failures = 0;
    const app = managementRemoteApp(service, {
      isLimited: () => failures >= limitAfter,
      recordFailure: () => { failures += 1; },
    }, 1024);
    const send = (method: string, path: string, body?: string, token?: string) => app.request(path, {
      method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body !== undefined ? { body } : {}),
    });
    return { service, call, send };
  }

  it("exposes only the dots operations, including Bearer evaluation", async () => {
    const { call, send } = remote();
    const { token } = await createMission(call);
    expect((await send("GET", "/v1/management/context", undefined, token)).status).toBe(200);
    expect((await send("GET", "/v1/management/changes", undefined, token)).status).toBe(200);
    expect((await send("POST", "/v1/management/events", "{}", token)).status).toBe(404);
    expect((await send("POST", "/v1/management/requests/x/outcome", "{}", token)).status).toBe(404);
    const evaluation = "/v1/management/requests/x/evaluate";
    expect((await send("POST", evaluation, '{"action":"accept"}')).status).toBe(401);
    expect(await (await send("POST", evaluation, '{"action":"accept"}', token)).json()).toMatchObject({ error: "not_found" });
    expect((await send("GET", "/v1/autonomous-loop/circuit-breaker", undefined, token)).status).toBe(404);
    expect((await send("GET", "/v1/admin/management/missions", undefined, token)).status).toBe(404);
  });

  it("limits repeated authentication failures with 429", async () => {
    const { call, send } = remote(2);
    const { token } = await createMission(call);
    expect((await send("GET", "/v1/management/context", undefined, "bad")).status).toBe(401);
    expect((await send("GET", "/v1/management/context", undefined, "bad")).status).toBe(401);
    expect((await send("GET", "/v1/management/context", undefined, token)).status).toBe(429);
  });

  it("refuses bodies over the limit", async () => {
    const { call, send } = remote();
    const { token } = await createMission(call);
    expect((await send("POST", "/v1/management/decisions", JSON.stringify({ rationale: "x".repeat(2048) }), token)).status).toBe(413);
  });
});

describe("public access gate (CC-MGMT-08 / CC-MGMT-INV-09)", () => {
  async function gated(verifyResult: unknown | null) {
    const { service, call } = setup();
    const { token } = await createMission(call);
    const verify = vi.fn(async () => verifyResult);
    const app = managementRemoteApp(service, { isLimited: () => false, recordFailure: () => {} }, 1024,
      { host: "cdgd-mgmt.ai-run-do.com", verify });
    const send = (host: string, assertion?: string) => app.request("/v1/management/context", {
      headers: { host, authorization: `Bearer ${token}`, ...(assertion ? { "cf-access-jwt-assertion": assertion } : {}) },
    });
    return { send, verify };
  }

  it("requires a verified Access assertion on the public host only", async () => {
    const denied = await gated(null);
    expect((await denied.send("cdgd-mgmt.ai-run-do.com", "x")).status).toBe(403);
    expect((await denied.send("CDGD-MGMT.ai-run-do.com:443")).status).toBe(403);
    expect((await denied.send("100.122.174.105:11113")).status).toBe(200);
    const allowed = await gated({ commonName: "dots" });
    expect((await allowed.send("cdgd-mgmt.ai-run-do.com", "jwt")).status).toBe(200);
    expect(allowed.verify).toHaveBeenCalledWith("jwt");
  });
});
