import { beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { makeTestDb } from "../../tests/helpers/db.js";
import { SidecarRecordsRepo } from "../delegation/sidecar/records-repo.js";
import { ConversationRepo } from "../control/conversation/repo.js";
import { ConversationService } from "../control/conversation/service.js";
import { delegationSidecarRouter } from "./delegation-sidecar.js";

let app: Hono;
let records: SidecarRecordsRepo;
let conversations: ConversationRepo;

beforeEach(() => {
  const db = makeTestDb();
  records = new SidecarRecordsRepo(db);
  conversations = new ConversationRepo(db);
  const service = new ConversationService({
    repo: conversations,
    now: () => 1_000,
    isSidecarParent: (id) => id === "parent",
    sessionActive: () => true,
    blockerFacts: () => ({ unansweredQuestions: 0, unfinishedChildRuns: 0, openPullRequests: 0, ownerUnknown: false }),
    deliver: async () => "delivered",
    startSuccessor: async () => ({ ok: false, error: "not in test" }),
    findSuccessorRun: () => null,
    requestSessionEnd: () => undefined,
  });
  app = delegationSidecarRouter({
    records,
    listRunsByParentSession: () => [],
    conversations: { service, repo: conversations },
    resolveScope: () => "",
    now: () => 1_000,
  });
});

async function post(path: string, body: unknown): Promise<Response> {
  return app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

const ingress = {
  platform: "discord", guild_id: "111111", thread_id: "222222", message_id: "333333", author_id: "444444",
  author_label: "neco", text: "設定画面を見て", bound_session_id: "parent", can_control_session: true,
};

describe("/v1/delegation/sidecar", () => {
  it("decides and records a route", async () => {
    const response = await post("/route", {
      parent_session_id: "parent",
      task_reference: "actio:t",
      request_version: 1,
      input: { kind: "list_or_text", size: "small", acceptanceDefined: true, scopeDefined: true, sensitive: false, openQuestions: false },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ route: "sidecar", reason: "bounded_work", budget_minutes: 20 });
    expect(records.listRouteDecisions("parent")).toHaveLength(1);
  });

  it("rejects malformed route requests", async () => {
    expect((await post("/route", { parent_session_id: "p", input: { kind: "nope" } })).status).toBe(400);
  });

  it("returns the observation without inventing cost", async () => {
    const response = await app.request("/observation?parent_session_id=parent");
    expect(await response.json()).toMatchObject({ parent_session_id: "parent", cost: { status: "not_measured" } });
    expect((await app.request("/observation")).status).toBe(400);
  });

  it("accepts conversation input, records delivery and hides text in the read model", async () => {
    const decision = await (await post("/conversations/ingress", ingress)).json() as { action: string; inputId: number };
    expect(decision).toMatchObject({ action: "inject", sessionId: "parent" });
    const duplicate = await (await post("/conversations/ingress", ingress)).json();
    expect(duplicate).toEqual({ action: "duplicate" });

    const view = await (await app.request("/conversations/discord:-:111111:222222")).json() as { open_inputs: Array<Record<string, unknown>> };
    expect(view.open_inputs[0]).not.toHaveProperty("text");

    expect((await post(`/conversations/inputs/${decision.inputId}/delivery`, { outcome: "delivered" })).status).toBe(200);
    expect((await post(`/conversations/inputs/${decision.inputId}/delivery`, { outcome: "delivered" })).status).toBe(409);
  });

  it("maps package save errors to HTTP statuses", async () => {
    expect((await post("/handoffs/missing/package", { session_id: "parent", package: {} })).status).toBe(404);
    expect((await post("/handoffs/missing/package", { package: {} })).status).toBe(400);
    expect((await post("/handoffs/missing/advance", {})).status).toBe(404);
  });
});
