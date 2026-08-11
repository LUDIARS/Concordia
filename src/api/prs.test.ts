import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

import { prsRouter } from "./prs.js";
import { makeTestApp } from "../../tests/helpers/test-app.js";
import { RevisorMergeError } from "../pr/revisor-merge-outcome.js";
import type { RevisorLocalPr, RevisorLocalPrReader } from "../pr/revisor-client.js";

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
  closeLocalPr?: (id: string, reason?: string) => Promise<void>,
  revisor?: RevisorLocalPrReader,
): Hono {
  const app = new Hono();
  app.route("/v1/prs", prsRouter({
    prs: env.prs,
    sessions: env.repo,
    staff: env.staff,
    revisorMerger: { mergeLocalPr },
    revisor,
    ...(closeLocalPr ? { revisorCloser: { closeLocalPr } } : {}),
  }));
  return app;
}

function revisorPr(status: string): RevisorLocalPr {
  return {
    id: "local-1",
    number: 1,
    repository: "LUDIARS/Concordia",
    title: "test",
    author: "session",
    status,
    checkStatus: "test_ok",
    headRef: "feat/test",
    baseRef: "main",
    headSha: "a".repeat(40),
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
  };
}

function closeRequest(body: unknown): RequestInit {
  return {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  };
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
    expect(await response.json()).toEqual({
      error: "local_pr_merge_failed",
      reason: "unknown",
      detail: "Revisor がマージを拒否しました。詳細は Concordia のログを参照してください。",
    });
  });

  it("treats an auto-merge that wins the race with this request as success", async () => {
    const env = makeTestApp();
    addSession(env);
    addRequester(env, "manager");
    const mergeLocalPr = vi.fn(async () => {
      throw new RevisorMergeError("already merged", {
        status: 409,
        revisorError: "This pull request has already been merged.",
      });
    });

    const response = await makePrsApp(env, mergeLocalPr).request("/v1/prs/local/local-1/merge", {
      method: "POST",
      body: JSON.stringify({ session_id: "session-1" }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ merged: true, local_pr_id: "local-1", already_merged: true });
    expect(env.repo.recentEvents("session-1", 1)[0]).toMatchObject({
      kind: "pr-merged",
      payload: expect.stringContaining("already_merged"),
    });
  });

  it("confirms a timed-out merge from the latest Revisor state and records the outcome", async () => {
    const env = makeTestApp();
    addSession(env);
    addRequester(env, "manager");
    const listLocalPrs = vi.fn<() => Promise<RevisorLocalPr[]>>()
      .mockResolvedValueOnce([revisorPr("open")])
      .mockResolvedValueOnce([revisorPr("merged")]);
    const revisor: RevisorLocalPrReader = {
      listLocalPrs,
      baseUrl: async () => "http://127.0.0.1:4240",
    };
    const mergeLocalPr = vi.fn(async () => {
      throw new RevisorMergeError("timed out", { timedOut: true });
    });

    const response = await makePrsApp(env, mergeLocalPr, undefined, revisor)
      .request("/v1/prs/local/local-1/merge", {
        method: "POST",
        body: JSON.stringify({ session_id: "session-1" }),
        headers: { "content-type": "application/json" },
      });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ merged: true, local_pr_id: "local-1", timed_out: true });
    expect(listLocalPrs).toHaveBeenCalledTimes(2);
    expect(env.repo.recentEvents("session-1", 1)[0]).toMatchObject({
      kind: "pr-merged",
      payload: expect.stringContaining("timed_out"),
    });
  });
});

describe("POST /v1/prs/local and fast-lane promotion", () => {
  it("passes only a strict explicit fast_lane opt-in to manual submission", async () => {
    const env = makeTestApp();
    addSession(env);
    const submitLocalPr = vi.fn(async () => ({ submitted: false as const, reason: "already_open" }));
    const app = new Hono();
    app.route("/v1/prs", prsRouter({ prs: env.prs, sessions: env.repo, submitLocalPr }));

    const accepted = await app.request("/v1/prs/local", closeRequest({
      session_id: "session-1",
      fast_lane: true,
    }));
    expect(accepted.status).toBe(200);
    expect(submitLocalPr).toHaveBeenCalledWith("session-1", { fastLane: true });

    const rejected = await app.request("/v1/prs/local", closeRequest({
      session_id: "session-1",
      fast_lane: "yes",
    }));
    expect(rejected.status).toBe(400);

    env.repo.setStatus("session-1", "ended", 2, 2);
    const inactive = await app.request("/v1/prs/local", closeRequest({
      session_id: "session-1",
      fast_lane: true,
    }));
    expect(inactive.status).toBe(403);
    expect(submitLocalPr).toHaveBeenCalledTimes(1);
  });

  it("lets only the active submitting session promote a queued PR and audits it", async () => {
    const env = makeTestApp();
    addSession(env);
    const promoteLocalPr = vi.fn(async () => undefined);
    const app = new Hono();
    app.route("/v1/prs", prsRouter({
      prs: env.prs,
      sessions: env.repo,
      revisor: {
        baseUrl: async () => "http://127.0.0.1:4240",
        listLocalPrs: async () => [{
          id: "local-1",
          number: 1,
          repository: "LUDIARS/Concordia",
          title: "変更",
          author: "concordia",
          status: "open",
          checkStatus: "queued",
          headRef: "feat/thing",
          baseRef: "main",
          headSha: "a",
          createdAt: "2026-08-11T00:00:00Z",
          updatedAt: "2026-08-11T00:00:00Z",
          sessionId: "session-1",
          reviewLane: "standard",
        }],
      },
      revisorPromoter: { promoteLocalPr },
    }));

    const response = await app.request(
      "/v1/prs/local/local-1/fast-lane",
      closeRequest({ session_id: "session-1" }),
    );
    expect(response.status).toBe(200);
    expect(promoteLocalPr).toHaveBeenCalledWith("local-1", "session-1");
    expect(env.repo.recentEvents("session-1", 1)[0]).toMatchObject({
      kind: "pr-fast-lane",
      payload: expect.stringContaining("local-1"),
    });

    addSession(env, "session-other");
    const denied = await app.request(
      "/v1/prs/local/local-1/fast-lane",
      closeRequest({ session_id: "session-other" }),
    );
    expect(denied.status).toBe(403);
  });
});

describe("POST /v1/prs/local/:id/close", () => {
  it("closes with the last human requester's merge_pr capability and records an audit event", async () => {
    const env = makeTestApp();
    addSession(env);
    addRequester(env, "manager");
    const closeLocalPr = vi.fn<(id: string, reason?: string) => Promise<void>>(async () => undefined);

    const response = await makePrsApp(env, async () => undefined, closeLocalPr)
      .request("/v1/prs/local/local-1/close", closeRequest({
        session_id: "session-1",
        reason: "already in main",
      }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ closed: true, local_pr_id: "local-1" });
    expect(closeLocalPr).toHaveBeenCalledWith("local-1", "already in main");
    expect(env.repo.recentEvents("session-1", 1)[0]).toMatchObject({
      kind: "pr-closed",
      payload: expect.stringContaining("local-1"),
    });
  });

  // board の整理は他セッションが出した PR を畳む作業。所有者に限ると用途が成立しない。
  it("closes a PR that this session did not create", async () => {
    const env = makeTestApp();
    addSession(env);
    addRequester(env, "manager");
    const closeLocalPr = vi.fn<(id: string, reason?: string) => Promise<void>>(async () => undefined);

    const response = await makePrsApp(env, async () => undefined, closeLocalPr)
      .request("/v1/prs/local/someone-elses-pr/close", closeRequest({ session_id: "session-1" }));

    expect(response.status).toBe(200);
    expect(closeLocalPr).toHaveBeenCalledWith("someone-elses-pr", undefined);
  });

  it("truncates an overlong reason before it reaches Revisor or the audit log", async () => {
    const env = makeTestApp();
    addSession(env);
    addRequester(env, "manager");
    const closeLocalPr = vi.fn<(id: string, reason?: string) => Promise<void>>(async () => undefined);

    await makePrsApp(env, async () => undefined, closeLocalPr)
      .request("/v1/prs/local/local-1/close", closeRequest({
        session_id: "session-1",
        reason: "x".repeat(900),
      }));

    expect(closeLocalPr.mock.calls[0]?.[1]).toHaveLength(500);
  });

  it("rejects a requester without merge_pr capability without closing", async () => {
    const env = makeTestApp();
    addSession(env);
    addRequester(env, "staff");
    const closeLocalPr = vi.fn(async () => undefined);

    const response = await makePrsApp(env, async () => undefined, closeLocalPr)
      .request("/v1/prs/local/local-1/close", closeRequest({ session_id: "session-1" }));

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "close_not_authorized" });
    expect(closeLocalPr).not.toHaveBeenCalled();
  });

  it("denies when the session has no human requester to authorize the close", async () => {
    const env = makeTestApp();
    addSession(env);
    const closeLocalPr = vi.fn(async () => undefined);

    const response = await makePrsApp(env, async () => undefined, closeLocalPr)
      .request("/v1/prs/local/local-1/close", closeRequest({ session_id: "session-1" }));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "close_authorizer_unknown" });
    expect(closeLocalPr).not.toHaveBeenCalled();
  });

  it("is unavailable when no Revisor closer is wired", async () => {
    const env = makeTestApp();
    addSession(env);
    addRequester(env, "manager");

    const response = await makePrsApp(env, async () => undefined)
      .request("/v1/prs/local/local-1/close", closeRequest({ session_id: "session-1" }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "local_pr_close_unavailable" });
  });

  it("does not expose the Revisor failure detail", async () => {
    const env = makeTestApp();
    addSession(env);
    addRequester(env, "manager");
    const closeLocalPr = vi.fn(async () => { throw new Error("Revisor is unavailable"); });

    const response = await makePrsApp(env, async () => undefined, closeLocalPr)
      .request("/v1/prs/local/local-1/close", closeRequest({ session_id: "session-1" }));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "local_pr_close_failed", detail: "Revisor local PR close failed" });
  });
});
