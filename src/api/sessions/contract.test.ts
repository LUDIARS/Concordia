import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { makeTestDb } from "../../../tests/helpers/db.js";
import { SessionsRepo } from "../../db/sessions-repo.js";
import { registerContractRoutes } from "./contract.js";
import type { SessionsApiDeps } from "./deps.js";

function setup(apply = vi.fn().mockResolvedValue({ ok: true, message: "ok" })) {
  const repo = new SessionsRepo(makeTestDb());
  repo.insertSession({ id: "s1", provider: "claude-code", repo_path: "/repo", repo_origin: null, branch: "feat/x",
    host: "test", started_at: 1, last_seen_at: 1, transcript_path: null,
    metadata: JSON.stringify({ model: "claude-opus-5-5", effort: "medium" }) });
  const insert = vi.fn((input: Record<string, unknown>) => ({ id: 1, ts: 1, ...input }));
  const app = new Hono();
  registerContractRoutes(app, { repo, chat: { insert }, applyModelEffort: apply } as unknown as SessionsApiDeps);
  return { app, insert, apply };
}

async function post(app: Hono, body: unknown): Promise<Response> {
  return app.request("/s1/effort", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

describe("POST /v1/sessions/:id/effort", () => {
  it("changes the effort and posts the notice to the session thread", async () => {
    const { app, insert, apply } = setup();
    const response = await post(app, { effort: "high", actor: "human", reason: "難所", requested_by: "neco" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, changed: true, effort: "high", previous: "medium" });
    expect(apply).toHaveBeenCalledWith({ sessionId: "s1", model: "claude-opus-5-5", effort: "high" });
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      channel: "system", session_id: "s1", author_label: "Concordia effort", text: expect.stringContaining("medium → high"),
    }));
  });

  it("returns the use-case status on failure without notifying", async () => {
    const { app, insert } = setup(vi.fn().mockResolvedValue({ ok: false, message: "down" }));
    const response = await post(app, { effort: "high", actor: "session", reason: "難所" });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: "runtime_apply_failed", message: "down" });
    expect(insert).not.toHaveBeenCalled();
  });

  it("rejects bodies without a reason or with unknown fields", async () => {
    const { app } = setup();
    expect((await post(app, { effort: "high", actor: "human" })).status).toBe(400);
    expect((await post(app, { effort: "high", actor: "human", reason: "x", extra: 1 })).status).toBe(400);
    expect((await post(app, { effort: "high", actor: "robot", reason: "x" })).status).toBe(400);
  });
});
