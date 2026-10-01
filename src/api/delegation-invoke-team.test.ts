/**
 * @implements spec/feature/task-workflow-v3.md — CC-AT-TEAM-02
 * `POST /v1/delegation/invoke` が actio_team_id を検証で落とさず service へ渡し、
 * 封印失敗の分類 (code / message / 候補チーム) を応答の detail に載せることを確かめる。
 */
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { makeTestDb } from "../../tests/helpers/db.js";
import { DelegationRepo } from "../db/delegation-repo.js";
import { delegationRouter } from "./delegation.js";
import type { DelegationService } from "../delegation/service.js";
import type { InvokeInput } from "../delegation/contracts.js";

function makeApp(result: Awaited<ReturnType<DelegationService["invoke"]>>) {
  const calls: InvokeInput[] = [];
  const service = { invoke: async (input: InvokeInput) => { calls.push(input); return result; } } as unknown as DelegationService;
  const app = new Hono();
  app.route("/v1/delegation", delegationRouter({ repo: new DelegationRepo(makeTestDb()), service }));
  return { app, calls };
}

const invoke = (app: Hono, body: unknown) => app.request("/v1/delegation/invoke", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

const DETAIL = {
  code: "actio_team_invalid", message: "候補チームから選んでください。",
  candidate_team_ids: ["team_a", "team_b"], hint: "actio_team_id を指定",
};

describe("POST /v1/delegation/invoke actio_team_id", () => {
  it("passes actio_team_id through input validation to the service", async () => {
    const { app, calls } = makeApp({ ok: false, error: "x", details: DETAIL });
    await invoke(app, { call_name: "impl", args: {}, actio_team_id: "team_b" });
    expect(calls[0]?.actio_team_id).toBe("team_b");
  });

  it("defaults a missing actio_team_id to null (no team chosen)", async () => {
    const { app, calls } = makeApp({ ok: false, error: "x" });
    await invoke(app, { call_name: "impl", args: {} });
    expect(calls[0]?.actio_team_id).toBeNull();
  });

  it("rejects an empty actio_team_id at the boundary", async () => {
    const { app, calls } = makeApp({ ok: false, error: "x" });
    const res = await invoke(app, { call_name: "impl", args: {}, actio_team_id: "  " });
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("returns the classified seal failure as detail", async () => {
    const { app } = makeApp({ ok: false, error: "Actio task registration or execution claim failed; inspect the existing task/run before retry", details: DETAIL });
    const res = await invoke(app, { call_name: "impl", args: {}, actio_team_id: "team_x" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ detail: DETAIL });
  });
});
