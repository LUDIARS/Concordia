import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { DeskRepository } from "../desk/repository.js";
import { DeskService } from "../desk/service.js";
import { deskRouter } from "./desk.js";

function setup(enabled = true) {
  let seq = 0;
  const service = new DeskService(new DeskRepository(makeTestDb()), { now: () => 1, id: () => `req-${++seq}`, isEnabled: () => enabled });
  const app = deskRouter({
    service,
    cardsForSession: () => [{ id: "c1", card_kind: "human_judgment", summary: "判断", state: "open", priority: "normal", raised_at: 1, closed_at: null }],
    sessionLinks: (id) => ({ discord: null, web: `http://cc/sessions/${id}` }),
  });
  const post = (body: unknown) => app.request("/requests", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { app, post, service };
}

describe("/v1/desk", () => {
  it("accepts once per client request id and returns the same request on retry (CC-V5-INV-01)", async () => {
    const { app, post } = setup();
    const first = await post({ client_request_id: "abcdefgh-1", body: "依頼", provider: "codex" });
    expect(first.status).toBe(202);
    const created = (await first.json()).request;
    const retry = await post({ client_request_id: "abcdefgh-1", body: "依頼", provider: "codex" });
    expect(retry.status).toBe(200);
    expect((await retry.json()).request.id).toBe(created.id);
    expect((await post({ client_request_id: "abcdefgh-1", body: "別", provider: "codex" })).status).toBe(409);
    const list = await (await app.request("/requests")).json();
    expect(list.requests).toHaveLength(1);
    expect(list.requests[0]).toMatchObject({ origin: "web", requester: "web", provider: "codex", state: "accepted", links: null });
  });

  it("accepts the Discord request key used by the window channel", async () => {
    const { post } = setup();
    const response = await post({ request_key: "discord:1:2", body: "依頼", requester: "999" });
    expect(response.status).toBe(202);
    expect((await response.json()).request).toMatchObject({ origin: "discord", requester: "999", provider: "claude" });
  });

  it("rejects bad input, disabled desk and unknown ids", async () => {
    expect((await setup().post({ client_request_id: "x", body: "a" })).status).toBe(400);
    expect((await setup().post({ client_request_id: "abcdefgh-1", request_key: "discord:1:2", body: "a" })).status).toBe(400);
    expect((await setup().post({ client_request_id: "abcdefgh-1", body: "   " })).status).toBe(400);
    expect((await setup(false).post({ client_request_id: "abcdefgh-1", body: "a" })).status).toBe(503);
    expect((await setup().app.request("/requests/none")).status).toBe(404);
  });

  it("shows the session links and cards on the detail once the request runs", async () => {
    const { app, post, service } = setup();
    const { request } = await (await post({ client_request_id: "abcdefgh-1", body: "依頼" })).json();
    const row = service.repo.find(request.id)!;
    const launching = service.repo.transition(row, { state: "launching", spawn_id: "s", launch_deadline_at: 10 }, 2)!;
    service.repo.transition(launching, { state: "running", session_id: "sess-1" }, 3);
    const detail = await (await app.request(`/requests/${request.id}`)).json();
    expect(detail.request).toMatchObject({ state: "running", open_cards: 1, links: { web: "http://cc/sessions/sess-1" } });
    expect(detail.cards).toHaveLength(1);
  });
});
