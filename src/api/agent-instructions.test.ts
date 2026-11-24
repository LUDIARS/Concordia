import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { createInstructionAccessGate } from "../agent-instructions/public-access.js";
import { InstructionService } from "../agent-instructions/instruction-service.js";
import { readInstructionIntakeToken } from "../agent-instructions/instruction-token.js";
import { SqliteAgentInstructionStore } from "../db/agent-instructions-repo.js";
import { registerAgentInstructionsRoute } from "./agent-instructions.js";

const HOST = "cc-home.ai-run-do.com";
const KEY = "k".repeat(40);

function setup(options: { key?: string | null | "unreadable"; annotate?: (id: string) => Record<string, unknown> | null } = {}) {
  const db = makeTestDb();
  const clock = { now: new Date("2026-11-21T00:00:00Z") };
  const service = new InstructionService({ store: new SqliteAgentInstructionStore(db), now: () => clock.now });
  const stored = { value: options.key === undefined ? KEY : options.key };
  const readToken = () => readInstructionIntakeToken(() => {
    if (stored.value === "unreadable") throw new Error("secret-box: cannot decrypt");
    return stored.value;
  });
  const warnings: Array<Record<string, unknown>> = [];
  const log = { info: () => {}, warn: (detail: Record<string, unknown>) => { warnings.push(detail); } };
  const app = new Hono();
  registerAgentInstructionsRoute(app, { service, access: createInstructionAccessGate({ publicHost: HOST, readToken }), log, ...(options.annotate ? { annotate: options.annotate } : {}) });
  // buildApp では後ろに SSO ゲートが居る。 ブリッジの応答がそこへ落ちないことを確かめる番兵。
  app.use("*", async (c) => c.text("fell through", 599 as never));
  const local = { host: "127.0.0.1:11111" };
  const tunnel = (token: string | null): Record<string, string> => ({
    host: HOST, "cf-ray": "8f0000000000-NRT", "cf-connecting-ip": "203.0.113.7",
    ...(token === null ? {} : { "x-excubitor-token": token }),
  });
  const json = (method: string, path: string, body: unknown, headers: Record<string, string> = local) =>
    app.request(path, { method, headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
  const get = (path: string, headers: Record<string, string> = local) => app.request(path, { headers });
  const advance = (ms: number) => { clock.now = new Date(clock.now.getTime() + ms); };
  return { app, json, get, tunnel, advance, stored, warnings };
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

  it("§6-6: public requests without the intake key are 401, with it polling is 200", async () => {
    const { get, tunnel, warnings } = setup();
    const denied = await get("/v1/instructions?agent=muse", tunnel(null));
    expect(denied.status).toBe(401);
    expect(denied.headers.get("cache-control")).toBe("no-store");
    expect(await denied.json()).toEqual({ error: { code: "token_required", message: expect.any(String) } });
    expect((await get("/v1/instructions?agent=muse", tunnel("wrong"))).status).toBe(401);
    // Host を書き換えてもトンネル由来ヘッダーで公開経由として扱う。
    expect((await get("/v1/instructions?agent=muse", { host: "127.0.0.1:11111", "cf-ray": "x" })).status).toBe(401);
    // CF Access の JWT だけでは通らない (Muse 経路は鍵 1 本)。
    expect((await get("/v1/instructions?agent=muse", { ...tunnel(null), "cf-access-jwt-assertion": "a.b.c" })).status).toBe(401);
    const allowed = await get("/v1/instructions?agent=muse", tunnel(KEY));
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ data: { instructions: [] } });
    // warn には理由だけ残り、 提示された値も鍵も出ない。
    expect(warnings.map((w) => w.reason)).toEqual(["missing", "mismatch", "missing", "missing"]);
    expect(JSON.stringify(warnings)).not.toContain(KEY);
    expect(JSON.stringify(warnings)).not.toContain("wrong");
  });

  it("§6-6: the key also works through Authorization (CF Access single-header service token)", async () => {
    const { get, tunnel, warnings } = setup();
    const viaAuth = (value: string, extra: Record<string, string> = {}) =>
      get("/v1/instructions?agent=muse", { ...tunnel(null), authorization: value, ...extra });
    expect((await viaAuth(KEY)).status).toBe(200);
    expect((await viaAuth(` ${KEY} `)).status).toBe(200);
    expect((await viaAuth("wrong-auth")).status).toBe(401);
    expect((await viaAuth(`Bearer ${KEY}`)).status).toBe(401);
    // x-excubitor-token があればそれだけで判定する。
    expect((await viaAuth(KEY, { "x-excubitor-token": "wrong-primary" })).status).toBe(401);
    expect((await viaAuth("wrong-auth", { "x-excubitor-token": KEY })).status).toBe(200);
    expect((await get("/v1/instructions?agent=muse", tunnel(null))).status).toBe(401);
    // warn に Authorization の中身も鍵も出ない。
    expect(JSON.stringify(warnings)).not.toContain(KEY);
    expect(JSON.stringify(warnings)).not.toContain("wrong-auth");
    expect(JSON.stringify(warnings)).not.toContain("wrong-primary");
  });

  it("§6-6: Authorization alone is rejected while the key is unset", async () => {
    const { get, tunnel } = setup({ key: null });
    expect((await get("/v1/instructions?agent=muse", { ...tunnel(null), authorization: KEY })).status).toBe(401);
  });

  it("§6-6: ack and result work through the tunnel with the key, and the key is checked before the body", async () => {
    const { json, tunnel } = setup();
    const { data } = await (await json("POST", "/v1/instructions", instruction)).json() as { data: { instruction: { id: string } } };
    expect((await json("POST", `/v1/instructions/${data.instruction.id}/ack`, { agent: "muse" }, tunnel(null))).status).toBe(401);
    // 本文が壊れていても鍵が無ければ 400 ではなく 401。
    expect((await json("POST", `/v1/instructions/${data.instruction.id}/ack`, { bogus: true }, tunnel(null))).status).toBe(401);
    expect((await json("POST", `/v1/instructions/${data.instruction.id}/result`, { bogus: true }, tunnel("wrong"))).status).toBe(401);
    expect((await json("POST", `/v1/instructions/${data.instruction.id}/ack`, { agent: "muse" }, tunnel(KEY))).status).toBe(202);
    const result = await json("POST", `/v1/instructions/${data.instruction.id}/result`, { agent: "muse", status: "done", summary: "ok" }, tunnel(KEY));
    expect(result.status).toBe(202);
  });

  it("§6-7: registration and state lookup are 403 through the tunnel even with the key", async () => {
    const { json, get, tunnel } = setup();
    const register = await json("POST", "/v1/instructions", instruction, tunnel(KEY));
    expect(register.status).toBe(403);
    expect(await register.json()).toMatchObject({ error: { code: "local_only" } });
    expect((await json("POST", "/v1/instructions", instruction, tunnel(null))).status).toBe(403);
    expect((await get("/v1/instructions/inst:muse:20261121T000000Z:ffffff", tunnel(KEY))).status).toBe(403);
  });

  it("rejects every public request while the key is unset or unreadable, loopback keeps working", async () => {
    for (const key of [null, "", "unreadable"] as const) {
      const { get, tunnel, warnings } = setup({ key });
      expect((await get("/v1/instructions?agent=muse", tunnel(KEY))).status).toBe(401);
      expect((await get("/v1/instructions?agent=muse", tunnel(""))).status).toBe(401);
      expect((await get("/v1/instructions?agent=muse")).status).toBe(200);
      expect(warnings[0]?.reason).toBe(key === "unreadable" ? "unreadable" : "unset");
    }
  });

  it("reads the key per request, so replacing it revokes the old one without a restart", async () => {
    const { get, tunnel, stored } = setup();
    expect((await get("/v1/instructions?agent=muse", tunnel(KEY))).status).toBe(200);
    stored.value = "n".repeat(40);
    expect((await get("/v1/instructions?agent=muse", tunnel(KEY))).status).toBe(401);
    expect((await get("/v1/instructions?agent=muse", tunnel("n".repeat(40)))).status).toBe(200);
  });

  it("does not answer outside /v1/instructions (the next middleware handles it)", async () => {
    const { get, tunnel } = setup();
    expect((await get("/v1/sessions")).status).toBe(599);
    expect((await get("/v1/instructions/x/y/z", tunnel(null))).status).toBe(401);
  });
});

const register = async (json: ReturnType<typeof setup>["json"], body: Record<string, unknown>) => {
  const { data } = await (await json("POST", "/v1/instructions", body)).json() as { data: { instruction: { id: string } } };
  return data.instruction.id;
};

describe("/v1/instructions/history (一覧の口、 loopback のみ)", () => {
  it("adds the playtest relay status to rows that have one", async () => {
    let relayed = "";
    const { json, get } = setup({ annotate: (id) => (id === relayed ? { voluptasState: "saved", voluptasId: "aipt_1", announceState: "delivered" } : null) });
    relayed = await register(json, { ...instruction, type: "playtest" });
    const other = await register(json, instruction);
    const { data } = await (await get("/v1/instructions/history")).json() as { data: { instructions: Array<Record<string, unknown>> } };
    expect(data.instructions.find((item) => item.id === relayed)?.relay).toEqual({ voluptasState: "saved", voluptasId: "aipt_1", announceState: "delivered" });
    expect(data.instructions.find((item) => item.id === other)).not.toHaveProperty("relay");
  });

  it("lists newest first with body and result, filters by agent / status, and keeps poll unchanged", async () => {
    const { json, get, advance } = setup();
    const first = await register(json, instruction);
    advance(1000);
    const second = await register(json, { ...instruction, agent: "dots", title: "dots の件" });
    await json("POST", `/v1/instructions/${first}/result`, { agent: "muse", status: "done", summary: "済み", detail: { b: 1 } });

    const listed = await get("/v1/instructions/history?limit=50");
    expect(listed.status).toBe(200);
    expect(listed.headers.get("cache-control")).toBe("no-store");
    const { data } = await listed.json() as { data: { instructions: Array<Record<string, unknown>> } };
    expect(data.instructions.map((item) => item.id)).toEqual([second, first]);
    expect(data.instructions[1]).toMatchObject({
      agent: "muse", status: "done", body: "Muse に実行させたい内容", resultSummary: "済み", resultDetail: { b: 1 }, params: {},
    });
    const onlyDots = await (await get("/v1/instructions/history?agent=dots")).json() as { data: { instructions: Array<{ id: string }> } };
    expect(onlyDots.data.instructions.map((item) => item.id)).toEqual([second]);
    const onlyDone = await (await get("/v1/instructions/history?status=done")).json() as { data: { instructions: Array<{ id: string }> } };
    expect(onlyDone.data.instructions.map((item) => item.id)).toEqual([first]);
    expect((await get("/v1/instructions/history?agent=nobody")).status).toBe(400);
    expect((await get("/v1/instructions/history?limit=101")).status).toBe(400);

    // 既存の poll は意味を変えない (agent 必須、 status 省略時 pending、 古い順)。
    expect((await get("/v1/instructions")).status).toBe(400);
    const polled = await (await get("/v1/instructions?agent=muse")).json() as { data: { instructions: unknown[] } };
    expect(polled.data.instructions).toEqual([]);
    const dotsPoll = await (await get("/v1/instructions?agent=dots")).json() as { data: { instructions: Array<{ id: string }> } };
    expect(dotsPoll.data.instructions.map((item) => item.id)).toEqual([second]);
  });

  it("is 403 through the tunnel even with a valid key", async () => {
    const { get, tunnel } = setup();
    const denied = await get("/v1/instructions/history", tunnel(KEY));
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: { code: "local_only" } });
    expect((await get("/v1/instructions/history?agent=muse", tunnel(null))).status).toBe(403);
  });
});

describe("宛先 dots (鍵は muse と共用、 宛先は agent で名乗る)", () => {
  it("serves dots through the tunnel with the same single key, and keeps each agent's instructions apart", async () => {
    const { json, get, tunnel } = setup();
    const dots = await register(json, { ...instruction, agent: "dots" });
    const muse = await register(json, instruction);
    const dotsPoll = await (await get("/v1/instructions?agent=dots", tunnel(KEY))).json() as { data: { instructions: Array<{ id: string }> } };
    expect(dotsPoll.data.instructions.map((item) => item.id)).toEqual([dots]);
    const musePoll = await (await get("/v1/instructions?agent=muse", tunnel(KEY))).json() as { data: { instructions: Array<{ id: string }> } };
    expect(musePoll.data.instructions.map((item) => item.id)).toEqual([muse]);
    expect((await get("/v1/instructions?agent=dots", tunnel("wrong"))).status).toBe(401);
    // 名乗った agent が指令の宛先と違えば 404 (他の宛先の指令は ack / result できない)。
    expect((await json("POST", `/v1/instructions/${dots}/ack`, { agent: "muse" }, tunnel(KEY))).status).toBe(404);
    expect((await json("POST", `/v1/instructions/${dots}/ack`, { agent: "dots" }, tunnel(KEY))).status).toBe(202);
    expect((await json("POST", `/v1/instructions/${dots}/result`, { agent: "dots", status: "done", summary: "x" }, tunnel(KEY))).status).toBe(202);
  });
});
