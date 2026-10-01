import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { ManagementRepository } from "../management/repository.js";
import { ManagementService } from "../management/service.js";
import { managementAdminRouter, managementRouter } from "./management.js";

function setup() {
  let sequence = 0;
  const service = new ManagementService(new ManagementRepository(makeTestDb()), {
    now: () => 1_000, id: () => `id-${++sequence}`, newToken: () => `tok-${++sequence}`, hashToken: (t) => `h:${t}`,
    inject: vi.fn(), liveSessions: () => [], departmentExists: () => true,
  });
  const app = new Hono();
  app.route("/v1/management", managementRouter(service));
  app.route("/v1/admin/management", managementAdminRouter(service));
  const call = (method: string, path: string, body?: unknown, token?: string) => app.request(path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { app, call, service };
}

async function createMission(call: ReturnType<typeof setup>["call"]) {
  const res = await call("POST", "/v1/admin/management/missions", {
    name: "CDGD", project_codes: ["Cf"], goal: "g", allowed_kinds: ["discussion"],
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
