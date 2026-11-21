import { generateKeyPairSync, sign, type JsonWebKey } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { createInstructionAccessGate } from "../agent-instructions/public-access.js";
import { InstructionService } from "../agent-instructions/instruction-service.js";
import { SqliteAgentInstructionStore } from "../db/agent-instructions-repo.js";
import { CfAccessVerifier } from "../management/cf-access.js";
import { registerAgentInstructionsRoute } from "./agent-instructions.js";

const TEAM = "https://example.cloudflareaccess.com";
const AUD = "b".repeat(64);
const HOST = "cc-home.ai-run-do.com";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...(publicKey.export({ format: "jwk" }) as JsonWebKey), kid: "k1" };

function assertion(payload: Record<string, unknown> = {}): string {
  const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = `${enc({ alg: "RS256", kid: "k1" })}.${enc({ iss: TEAM, aud: [AUD], exp: Math.floor(Date.now() / 1000) + 600, common_name: "svc", ...payload })}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`;
}

function setup(options: { access?: boolean } = {}) {
  const db = makeTestDb();
  const clock = { now: new Date("2026-11-21T00:00:00Z") };
  const service = new InstructionService({ store: new SqliteAgentInstructionStore(db), now: () => clock.now });
  const verifier = options.access === false ? null : new CfAccessVerifier({ teamDomain: TEAM, audience: AUD }, async () => ({ keys: [jwk] }));
  const app = new Hono();
  registerAgentInstructionsRoute(app, { service, access: createInstructionAccessGate({ publicHost: HOST, verifier }) });
  // buildApp では後ろに SSO ゲートが居る。 ブリッジの応答がそこへ落ちないことを確かめる番兵。
  app.use("*", async (c) => c.text("fell through", 599 as never));
  const local = { host: "127.0.0.1:11111" };
  const tunnel = (withToken: boolean): Record<string, string> => ({
    host: HOST, "cf-ray": "8f0000000000-NRT", "cf-connecting-ip": "203.0.113.7",
    ...(withToken ? { "cf-access-jwt-assertion": assertion() } : {}),
  });
  const json = (method: string, path: string, body: unknown, headers: Record<string, string> = local) =>
    app.request(path, { method, headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
  const get = (path: string, headers: Record<string, string> = local) => app.request(path, { headers });
  const advance = (ms: number) => { clock.now = new Date(clock.now.getTime() + ms); };
  return { app, json, get, tunnel, advance };
}

const instruction = { agent: "muse", type: "run_task", title: "指令の件名", body: "Muse に実行させたい内容", params: {} };

describe("/v1/instructions (spec/feature/agent-instructions-bridge.md)", () => {
  it("§6-2: register → poll returns one → ack 202 → result 202 delivered → poll returns none", async () => {
    const { json, get } = setup();
    const created = await json("POST", "/v1/instructions", instruction);
    expect(created.status).toBe(201);
    const { data } = await created.json() as { data: { instruction: { id: string; status: string; createdAt: string } } };
    expect(data.instruction).toEqual({ id: expect.stringMatching(/^inst:muse:20261121T000000Z:[0-9a-f]{6}$/), status: "pending", createdAt: "2026-11-21T00:00:00Z" });
    const id = data.instruction.id;

    const polled = await get("/v1/instructions?agent=muse&status=pending&limit=10");
    expect(polled.status).toBe(200);
    expect(polled.headers.get("cache-control")).toBe("no-store");
    expect(await polled.json()).toEqual({ data: { instructions: [{ id, type: "run_task", title: "指令の件名", body: "Muse に実行させたい内容", params: {}, createdAt: "2026-11-21T00:00:00Z" }] } });

    const acked = await json("POST", `/v1/instructions/${encodeURIComponent(id)}/ack`, { agent: "muse" });
    expect(acked.status).toBe(202);
    expect(await acked.json()).toMatchObject({ duplicate: false, data: { instruction: { id, status: "acked" } } });
    const ackAgain = await json("POST", `/v1/instructions/${id}/ack`, { agent: "muse" });
    expect(ackAgain.status).toBe(200);
    expect(await ackAgain.json()).toMatchObject({ duplicate: true });

    const result = await json("POST", `/v1/instructions/${id}/result`, { agent: "muse", status: "done", summary: "完了", detail: {} });
    expect(result.status).toBe(202);
    expect(await result.json()).toMatchObject({ delivered: true, failed: false, duplicate: false, data: { instruction: { id, status: "done" } } });

    expect(await (await get("/v1/instructions?agent=muse")).json()).toEqual({ data: { instructions: [] } });
    const state = await get(`/v1/instructions/${id}`);
    expect(state.status).toBe(200);
    expect(await state.json()).toMatchObject({ data: { instruction: { id, status: "done", resultSummary: "完了" } } });
  });

  it("§6-3: same result again is 200 duplicate, a different result is 409, ack after finish is 409", async () => {
    const { json } = setup();
    const { data } = await (await json("POST", "/v1/instructions", instruction)).json() as { data: { instruction: { id: string } } };
    const id = data.instruction.id;
    await json("POST", `/v1/instructions/${id}/result`, { agent: "muse", status: "done", summary: "ok" });
    const again = await json("POST", `/v1/instructions/${id}/result`, { agent: "muse", status: "done", summary: "ok" });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ duplicate: true, delivered: true, failed: false });
    const other = await json("POST", `/v1/instructions/${id}/result`, { agent: "muse", status: "failed", summary: "ok" });
    expect(other.status).toBe(409);
    expect(await other.json()).toEqual({ error: { code: "result_conflict", message: expect.any(String) } });
    expect((await json("POST", `/v1/instructions/${id}/ack`, { agent: "muse" })).status).toBe(409);
  });

  it("§6-4: unknown fields and types outside the allowlist are 400 with {error:{code,message}}", async () => {
    const { json, app } = setup();
    const unknown = await json("POST", "/v1/instructions", { ...instruction, priority: 1 });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toEqual({ error: { code: "unknown_field", message: expect.stringContaining("priority") } });
    const badType = await json("POST", "/v1/instructions", { ...instruction, type: "shell" });
    expect(badType.status).toBe(400);
    expect(await badType.json()).toMatchObject({ error: { code: "unsupported_type" } });
    const { data } = await (await json("POST", "/v1/instructions", instruction)).json() as { data: { instruction: { id: string } } };
    expect((await json("POST", `/v1/instructions/${data.instruction.id}/ack`, { agent: "muse", extra: 1 })).status).toBe(400);
    expect((await json("POST", `/v1/instructions/${data.instruction.id}/result`, { agent: "muse", status: "done", summary: "ok", more: 1 })).status).toBe(400);
    const notJson = await app.request("/v1/instructions", { method: "POST", headers: { host: "127.0.0.1", "content-type": "text/plain" }, body: "x" });
    expect(notJson.status).toBe(400);
  });

  it("returns 404 for unknown ids and 400 for bad poll queries", async () => {
    const { json, get } = setup();
    expect((await json("POST", "/v1/instructions/inst:muse:20261121T000000Z:ffffff/ack", { agent: "muse" })).status).toBe(404);
    expect((await json("POST", "/v1/instructions/nope/result", { agent: "muse", status: "done", summary: "x" })).status).toBe(404);
    expect((await get("/v1/instructions/inst:muse:20261121T000000Z:ffffff")).status).toBe(404);
    expect((await get("/v1/instructions")).status).toBe(400);
    expect((await get("/v1/instructions?agent=muse&limit=21")).status).toBe(400);
    expect((await get("/v1/instructions?agent=muse&limit=0")).status).toBe(400);
    expect((await get("/v1/instructions/x/y/z")).status).toBe(404);
  });

  it("§6-5: an instruction acked for 30 minutes without result is delivered again", async () => {
    const { json, get, advance } = setup();
    const { data } = await (await json("POST", "/v1/instructions", instruction)).json() as { data: { instruction: { id: string } } };
    await json("POST", `/v1/instructions/${data.instruction.id}/ack`, { agent: "muse" });
    advance(29 * 60 * 1000);
    expect(await (await get("/v1/instructions?agent=muse")).json()).toEqual({ data: { instructions: [] } });
    advance(2 * 60 * 1000);
    const again = await (await get("/v1/instructions?agent=muse")).json() as { data: { instructions: Array<{ id: string }> } };
    expect(again.data.instructions.map((item) => item.id)).toEqual([data.instruction.id]);
  });

  it("§6-6: public requests without a verified Access token are 403, with one polling is 200", async () => {
    const { get, tunnel } = setup();
    const denied = await get("/v1/instructions?agent=muse", tunnel(false));
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: { code: "access_required", message: expect.any(String) } });
    // Host を書き換えてもトンネル由来ヘッダーで公開経由として扱う。
    expect((await get("/v1/instructions?agent=muse", { host: "127.0.0.1:11111", "cf-ray": "x" })).status).toBe(403);
    expect((await get("/v1/instructions?agent=muse", { ...tunnel(false), "cf-access-jwt-assertion": assertion({ aud: ["c".repeat(64)] }) })).status).toBe(403);
    const allowed = await get("/v1/instructions?agent=muse", tunnel(true));
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ data: { instructions: [] } });
  });

  it("§6-6: ack and result work through the tunnel with a verified token", async () => {
    const { json, tunnel } = setup();
    const { data } = await (await json("POST", "/v1/instructions", instruction)).json() as { data: { instruction: { id: string } } };
    expect((await json("POST", `/v1/instructions/${data.instruction.id}/ack`, { agent: "muse" }, tunnel(false))).status).toBe(403);
    expect((await json("POST", `/v1/instructions/${data.instruction.id}/ack`, { agent: "muse" }, tunnel(true))).status).toBe(202);
    const result = await json("POST", `/v1/instructions/${data.instruction.id}/result`, { agent: "muse", status: "done", summary: "ok" }, tunnel(true));
    expect(result.status).toBe(202);
  });

  it("§6-7: registration and state lookup are 403 through the tunnel even with a verified token", async () => {
    const { json, get, tunnel } = setup();
    const register = await json("POST", "/v1/instructions", instruction, tunnel(true));
    expect(register.status).toBe(403);
    expect(await register.json()).toMatchObject({ error: { code: "local_only" } });
    expect((await get("/v1/instructions/inst:muse:20261121T000000Z:ffffff", tunnel(true))).status).toBe(403);
  });

  it("rejects every public request when Access is not configured", async () => {
    const { get, tunnel } = setup({ access: false });
    expect((await get("/v1/instructions?agent=muse", tunnel(true))).status).toBe(403);
    expect((await get("/v1/instructions?agent=muse")).status).toBe(200);
  });

  it("does not answer outside /v1/instructions (the next middleware handles it)", async () => {
    const { get } = setup();
    expect((await get("/v1/sessions")).status).toBe(599);
  });
});
