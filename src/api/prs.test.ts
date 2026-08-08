import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

import { prsRouter } from "./prs.js";
import { makeTestApp } from "../../tests/helpers/test-app.js";

function addSession(env: ReturnType<typeof makeTestApp>, sessionId = "session-1"): void {
  env.repo.insertSession({
    id: sessionId,
    provider: "codex-cli",
    repo_path: "E:/Document/Ars/Concordia",
    repo_origin: "https://github.com/LUDIARS/Concordia.git",
    branch: "feat/admin-authorized-merge",
    host: "host",
    started_at: 1,
    last_seen_at: 1,
    transcript_path: null,
    metadata: null,
  });
}

function addRequester(env: ReturnType<typeof makeTestApp>, role: "staff" | "manager", userId = "user-1"): void {
  env.staff.touch({ platform: "discord", platformUserId: userId });
  env.staff.update("discord", userId, { role });
  env.repo.appendEvent({
    session_id: "session-1",
    ts: 2,
    kind: "inject",
    payload: { source: `discord:${userId}:channel:message` },
  });
}

function makePrsApp(
  env: ReturnType<typeof makeTestApp>,
  mergeLocalPr: (id: string) => Promise<void>,
): Hono {
  const app = new Hono();
  app.route("/v1/prs", prsRouter({
    prs: env.prs,
    sessions: env.repo,
    staff: env.staff,
    revisorMerger: { mergeLocalPr },
  }));
  return app;
}

describe("POST /v1/prs/local/:id/merge", () => {
  it("merges with the last human requester's merge_pr capability and records an audit event", async () => {
    const env = makeTestApp();
    addSession(env);
    addRequester(env, "manager");
    const mergeLocalPr = vi.fn(async () => undefined);

    const response = await makePrsApp(env, mergeLocalPr).request("/v1/prs/local/local-1/merge", {
      method: "POST",
      body: JSON.stringify({ session_id: "session-1" }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(200);
    expect(mergeLocalPr).toHaveBeenCalledWith("local-1");
    expect(env.repo.recentEvents("session-1", 1)[0]).toMatchObject({
      kind: "pr-merged",
      payload: expect.stringContaining("local-1"),
    });
  });

  it("rejects a requester without merge_pr capability without merging", async () => {
    const env = makeTestApp();
    addSession(env);
    addRequester(env, "staff");
    const mergeLocalPr = vi.fn(async () => undefined);

    const response = await makePrsApp(env, mergeLocalPr).request("/v1/prs/local/local-1/merge", {
      method: "POST",
      body: JSON.stringify({ session_id: "session-1" }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "merge_not_authorized" });
    expect(mergeLocalPr).not.toHaveBeenCalled();
  });

  it("rejects an unknown requester without merging", async () => {
    const env = makeTestApp();
    addSession(env);
    const mergeLocalPr = vi.fn(async () => undefined);

    const response = await makePrsApp(env, mergeLocalPr).request("/v1/prs/local/local-1/merge", {
      method: "POST",
      body: JSON.stringify({ session_id: "session-1" }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "merge_authorizer_unknown" });
    expect(mergeLocalPr).not.toHaveBeenCalled();
  });

  it("does not expose the Revisor failure detail", async () => {
    const env = makeTestApp();
    addSession(env);
    addRequester(env, "manager");
    const mergeLocalPr = vi.fn(async () => { throw new Error("Revisor is unavailable"); });

    const response = await makePrsApp(env, mergeLocalPr).request("/v1/prs/local/local-1/merge", {
      method: "POST",
      body: JSON.stringify({ session_id: "session-1" }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "local_pr_merge_failed", detail: "Revisor local PR merge failed" });
  });
});
