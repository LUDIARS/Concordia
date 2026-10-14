/**
 * @implements spec/feature/personal-ai-budget.md §3 — 委託の子への依頼者の引き継ぎ
 * `POST /v1/delegation/invoke` が parent_session_id の依頼者と会社を帰属専用の `budget_requester` で
 * 子へ渡し、 mention に使う `requester_discord_user_id` は body の指定のまま (引き継がない) ことを確かめる。
 */
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { makeTestDb } from "../../tests/helpers/db.js";
import { DelegationRepo } from "../db/delegation-repo.js";
import { delegationRouter } from "./delegation.js";
import type { DelegationService } from "../delegation/service.js";
import type { InvokeInput } from "../delegation/contracts.js";
import type { SessionsRepo } from "../db/sessions-repo.js";

function makeApp(parents: Record<string, Record<string, unknown>>) {
  const calls: InvokeInput[] = [];
  const service = { invoke: async (input: InvokeInput) => { calls.push(input); return { ok: false, error: "x" }; } } as unknown as DelegationService;
  const sessions = {
    findSession: (id: string) => parents[id] ? { id, repo_path: null, metadata: JSON.stringify(parents[id]) } : null,
  } as unknown as SessionsRepo;
  const app = new Hono();
  app.route("/v1/delegation", delegationRouter({ repo: new DelegationRepo(makeTestDb()), service, sessions }));
  return { app, calls };
}

const invoke = (app: Hono, body: unknown) => app.request("/v1/delegation/invoke", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

const PARENT = { subsidiary_id: "glab", discord_requester_user_id: "111111111" };

describe("POST /v1/delegation/invoke — 依頼者の引き継ぎ", () => {
  it("body に依頼者が無ければ、 親の依頼者と会社を帰属専用で引き継ぎ、 mention 用の値には入れない", async () => {
    const { app, calls } = makeApp({ parent: PARENT });
    await invoke(app, { call_name: "impl", args: {}, parent_session_id: "parent" });
    expect(calls[0]?.budget_requester).toEqual({ subsidiary_id: "glab", discord_user_id: "111111111" });
    expect(calls[0]?.requester_discord_user_id).toBeNull();
  });

  it("body に依頼者の指定があればそれを優先し、 引き継がない", async () => {
    const { app, calls } = makeApp({ parent: PARENT });
    await invoke(app, { call_name: "impl", args: {}, parent_session_id: "parent", requester_discord_user_id: "222222222" });
    expect(calls[0]?.budget_requester).toBeNull();
    expect(calls[0]?.requester_discord_user_id).toBe("222222222");
  });

  it("親に依頼者が無ければ引き継がない", async () => {
    const { app, calls } = makeApp({ parent: { subsidiary_id: "glab" } });
    await invoke(app, { call_name: "impl", args: {}, parent_session_id: "parent" });
    expect(calls[0]?.budget_requester).toBeNull();
  });

  it("孫への委託は、 親 (子) が引き継いだ組をそのまま渡す", async () => {
    const { app, calls } = makeApp({
      child: { personal_budget_requester: { subsidiary_id: "glab", discord_user_id: "111111111" } },
    });
    await invoke(app, { call_name: "impl", args: {}, parent_session_id: "child" });
    expect(calls[0]?.budget_requester).toEqual({ subsidiary_id: "glab", discord_user_id: "111111111" });
    expect(calls[0]?.requester_discord_user_id).toBeNull();
  });

  it("親が無い委託は引き継がない", async () => {
    const { app, calls } = makeApp({});
    await invoke(app, { call_name: "impl", args: {} });
    expect(calls[0]?.budget_requester).toBeNull();
  });
});
