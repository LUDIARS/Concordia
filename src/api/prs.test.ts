import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

import { prsRouter, type PrsApiDeps } from "./prs.js";
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

/**
 * マージはプロジェクト一致で認可するので、 読み取り口 (Revisor) は常に要る。
 * 個別の状態遷移を見たいテストだけが reader を差し替える。
 */
function defaultRevisorReader(): RevisorLocalPrReader {
  return {
    listLocalPrs: async () => [revisorPr("open")],
    baseUrl: async () => "http://127.0.0.1:4240",
  };
}

function makePrsApp(
  env: ReturnType<typeof makeTestApp>,
  mergeLocalPr: (id: string) => Promise<void>,
  closeLocalPr?: (id: string, reason?: string) => Promise<void>,
  revisor: RevisorLocalPrReader | null = defaultRevisorReader(),
  managedProjects: PrsApiDeps["managedProjects"] = defaultManagedProjects(),
): Hono {
  const app = new Hono();
  app.route("/v1/prs", prsRouter({
    prs: env.prs,
    sessions: env.repo,
    staff: env.staff,
    revisorMerger: { mergeLocalPr },
    revisor: revisor ?? undefined,
    managedProjects,
    ...(closeLocalPr ? { revisorCloser: { closeLocalPr } } : {}),
  }));
  return app;
}

/** 既定の管理集合。 LUDIARS 配下のプロジェクトが project_codes に登録されている状態。 */
function defaultManagedProjects(...projects: string[]): PrsApiDeps["managedProjects"] {
  const registered = projects.length > 0 ? projects : ["LUDIARS/Concordia"];
  return {
    isRegisteredProject: (repoOrigin) =>
      registered.some((p) => p.toLowerCase() === repoOrigin.toLowerCase()),
    isTeamRepo: () => false,
  };
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
    // マージは人間の判断が要る。 指示者を確認できないセッションが自分の判断でマージしない。
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

  it("rejects an unknown session even if orphan inject events exist", async () => {
    // session_events には sessions への外部キーがない。イベントだけで session の実在を
    // 代用すると、任意 ID の inject を認可コンテキストにできてしまう。
    const env = makeTestApp();
    addRequester(env, "manager");
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

  it("still finds the instruction after it falls out of the recent-event window", async () => {
    // 長いセッションで最後の人間 inject が直近 100 件から溢れても、 指示が無かったことには
    // しない (同じセッションで通ったり通らなかったりする原因だった)。
    const env = makeTestApp();
    addSession(env);
    addRequester(env, "manager");
    for (let i = 0; i < 150; i += 1) {
      env.repo.appendEvent({ session_id: "session-1", ts: 10 + i, kind: "status", payload: { i } });
    }
    const mergeLocalPr = vi.fn(async () => undefined);

    const response = await makePrsApp(env, mergeLocalPr).request("/v1/prs/local/local-1/merge", {
      method: "POST",
      body: JSON.stringify({ session_id: "session-1" }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(200);
    expect(mergeLocalPr).toHaveBeenCalledWith("local-1");
  });

  it("merges another project's PR from a Castra cwd session (cwd is no longer consulted)", async () => {
    // 置き換え前の規則では session.repo_origin が LUDIARS/Castra に固定されるため
    // merge_project_scope_denied で止まっていた (2026-09-05 に Ludellus / Ludellus-Server で発生)。
    const env = makeTestApp();
    env.repo.insertSession({
      id: "session-1",
      provider: "codex-cli",
      repo_path: "E:/Document/Ars",
      repo_origin: "https://github.com/LUDIARS/Castra.git",
      branch: "main",
      host: "host",
      started_at: 1,
      last_seen_at: 1,
      transcript_path: null,
      metadata: null,
    });
    addRequester(env, "manager");
    const mergeLocalPr = vi.fn(async () => undefined);
    const revisor: RevisorLocalPrReader = {
      listLocalPrs: async () => [{ ...revisorPr("open"), repository: "LUDIARS/Ludellus-Server" }],
      baseUrl: async () => "http://127.0.0.1:4240",
    };

    const response = await makePrsApp(
      env, mergeLocalPr, undefined, revisor, defaultManagedProjects("LUDIARS/Ludellus-Server"),
    ).request("/v1/prs/local/local-1/merge", {
      method: "POST",
      body: JSON.stringify({ session_id: "session-1" }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(200);
    expect(mergeLocalPr).toHaveBeenCalledWith("local-1");
  });

  it("refuses a PR whose repository Concordia does not manage", async () => {
    const env = makeTestApp();
    addSession(env);
    addRequester(env, "manager");
    const mergeLocalPr = vi.fn(async () => undefined);
    const revisor: RevisorLocalPrReader = {
      listLocalPrs: async () => [{ ...revisorPr("open"), repository: "outsider/not-ours" }],
      baseUrl: async () => "http://127.0.0.1:4240",
    };

    const response = await makePrsApp(env, mergeLocalPr, undefined, revisor)
      .request("/v1/prs/local/local-1/merge", {
        method: "POST",
        body: JSON.stringify({ session_id: "session-1" }),
        headers: { "content-type": "application/json" },
      });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: "merge_project_scope_denied",
      reason: "project_not_registered",
    });
    expect(mergeLocalPr).not.toHaveBeenCalled();
  });

  it("records the project and the authorizer in the merge audit event", async () => {
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
    const merged = env.repo.eventsByKind("session-1", "pr-merged");
    expect(merged).toHaveLength(1);
    expect(JSON.parse(merged[0]!.payload)).toMatchObject({
      project: "LUDIARS/Concordia",
      project_registered_via: "project_codes",
      authorizer: { platform: "discord", user_id: "user-1", role: "manager" },
    });
  });

  it("refuses when Revisor cannot tell us which project the PR belongs to", async () => {
    // 所属が確認できないままマージを通さない (可用性ではなく認可の問題)。
    const env = makeTestApp();
    addSession(env);
    addRequester(env, "manager");
    const mergeLocalPr = vi.fn(async () => undefined);

    const response = await makePrsApp(env, mergeLocalPr).request("/v1/prs/local/local-2/merge", {
      method: "POST",
      body: JSON.stringify({ session_id: "session-1" }),
      headers: { "content-type": "application/json" },
    });

    // local-2 は Revisor 一覧に無いので所属を確認できない。
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: "merge_project_scope_denied",
      reason: "local_pr_repo_unknown",
    });
    expect(mergeLocalPr).not.toHaveBeenCalled();
  });

  it("fails closed when the managed-project registry is unavailable", async () => {
    const env = makeTestApp();
    addSession(env);
    addRequester(env, "manager");
    const mergeLocalPr = vi.fn(async () => undefined);
    const app = new Hono();
    app.route("/v1/prs", prsRouter({
      prs: env.prs,
      sessions: env.repo,
      staff: env.staff,
      revisorMerger: { mergeLocalPr },
      revisor: defaultRevisorReader(),
    }));

    const response = await app.request("/v1/prs/local/local-1/merge", {
      method: "POST",
      body: JSON.stringify({ session_id: "session-1" }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "local_pr_merge_unavailable" });
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
      detail: "Revisor がマージを拒否しました。Concordia の管理者に確認してください。",
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
    // 1 回目はプロジェクト一致の確認、 2 回目は要求前の実状態、 3 回目は打ち切り後の読み直し。
    const listLocalPrs = vi.fn<() => Promise<RevisorLocalPr[]>>()
      .mockResolvedValueOnce([revisorPr("open")])
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
    expect(listLocalPrs).toHaveBeenCalledTimes(3);
    expect(env.repo.recentEvents("session-1", 1)[0]).toMatchObject({
      kind: "pr-merged",
      payload: expect.stringContaining("timed_out"),
    });
  });
});

describe("POST /v1/prs/local and fast-lane promotion", () => {
  it("passes only a strict explicit fast_lane opt-in to manual submission", async () => {
    const EMPTY_PRS = { list: () => [] } as never;
    let active = true;
    const sessions = {
      findSession: (id: string) => id === "session-1" ? { id, status: active ? "active" : "ended" } : null,
    } as unknown as NonNullable<PrsApiDeps["sessions"]>;
    const submitLocalPr = vi.fn(async () => ({ submitted: false as const, reason: "already_open" }));
    const app = prsRouter({ prs: EMPTY_PRS, sessions, submitLocalPr });

    const accepted = await app.request("/local", closeRequest({
      session_id: "session-1",
      fast_lane: true,
    }));
    expect(accepted.status).toBe(200);
    expect(submitLocalPr).toHaveBeenCalledWith("session-1", { fastLane: true });

    const rejected = await app.request("/local", closeRequest({
      session_id: "session-1",
      fast_lane: "yes",
    }));
    expect(rejected.status).toBe(400);

    active = false;
    const inactive = await app.request("/local", closeRequest({
      session_id: "session-1",
      fast_lane: true,
    }));
    expect(inactive.status).toBe(403);
    expect(submitLocalPr).toHaveBeenCalledTimes(1);
  });

  it("lets any active session promote a queued PR and audits submitter and promoter", async () => {
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

    // 急がせたい人と出した人は同じとは限らない。委託先が出した PR を委託元が昇格でき、
    // 提出元セッションが終了した PR も他セッションから救える。
    addSession(env, "session-other");
    const byOther = await app.request(
      "/v1/prs/local/local-1/fast-lane",
      closeRequest({ session_id: "session-other" }),
    );
    expect(byOther.status).toBe(200);
    expect(promoteLocalPr).toHaveBeenCalledWith("local-1", "session-other");
    // 共有予約枠を消費した記録は、提出元と昇格者の両方が辿れること。
    expect(env.repo.recentEvents("session-other", 1)[0]?.payload)
      .toEqual(expect.stringContaining("session-1"));

    // 名乗りとして active session であることは要求する。
    const unknown = await app.request(
      "/v1/prs/local/local-1/fast-lane",
      closeRequest({ session_id: "session-missing" }),
    );
    expect(unknown.status).toBe(403);
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

describe("GET /v1/prs/revisor/digest", () => {
  it("renders the Revisor local PR digest with the teaching note", async () => {
    const env = makeTestApp();
    const app = makePrsApp(env, async () => undefined, undefined, {
      listLocalPrs: async () => [revisorPr("open"), revisorPr("merged")],
      baseUrl: async () => { throw new Error("digest must not resolve the Revisor UI URL"); },
    });
    const res = await app.request("/v1/prs/revisor/digest");
    expect(res.status).toBe(200);
    const body = await res.json() as { markdown: string; open_count: number; error: string | null };
    expect(body.error).toBeNull();
    expect(body.open_count).toBe(1);
    expect(body.markdown).toContain("Revisor local PR 一覧");
    expect(body.markdown).toContain("GitHub PR のキューは別系統");
  });

  it("filters by repository", async () => {
    const env = makeTestApp();
    const app = makePrsApp(env, async () => undefined, undefined, {
      listLocalPrs: async () => [
        revisorPr("open"),
        { ...revisorPr("open"), id: "local-2", number: 2, repository: "LUDIARS/Lictor", title: "other" },
      ],
      baseUrl: async () => { throw new Error("digest must not resolve the Revisor UI URL"); },
    });
    const res = await app.request("/v1/prs/revisor/digest?repository=LUDIARS%2FConcordia");
    const body = await res.json() as { markdown: string; open_count: number };
    expect(body.open_count).toBe(1);
    expect(body.markdown).not.toContain("other");
  });

  it("rejects local-path repository filters without querying Revisor", async () => {
    const env = makeTestApp();
    const listLocalPrs = vi.fn(async () => [revisorPr("open")]);
    const app = makePrsApp(env, async () => undefined, undefined, {
      listLocalPrs,
      baseUrl: async () => { throw new Error("digest must not resolve the Revisor UI URL"); },
    });

    const res = await app.request("/v1/prs/revisor/digest?repository=C%3A%2Fworkspace%2Fprivate-repo");

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "repository_invalid" });
    expect(listLocalPrs).not.toHaveBeenCalled();
  });

  it("rejects traversal-shaped repository filters", async () => {
    const env = makeTestApp();
    const listLocalPrs = vi.fn(async () => [revisorPr("open")]);
    const app = makePrsApp(env, async () => undefined, undefined, {
      listLocalPrs,
      baseUrl: async () => { throw new Error("digest must not resolve the Revisor UI URL"); },
    });

    const res = await app.request("/v1/prs/revisor/digest?repository=..%2Fprivate-repo");

    expect(res.status).toBe(400);
    expect(listLocalPrs).not.toHaveBeenCalled();
  });

  it("answers 200 with an explanation when Revisor is not configured", async () => {
    const env = makeTestApp();
    const app = makePrsApp(env, async () => undefined, undefined, null);
    const res = await app.request("/v1/prs/revisor/digest");
    expect(res.status).toBe(200);
    const body = await res.json() as { markdown: string; error: string | null };
    expect(body.error).toBe("revisor_not_configured");
    expect(body.markdown).toContain("有効になっていません");
  });

  it("answers 200 with the failure reason when Revisor is down", async () => {
    const env = makeTestApp();
    const app = makePrsApp(env, async () => undefined, undefined, {
      listLocalPrs: async () => { throw new Error("connect ECONNREFUSED"); },
      baseUrl: async () => { throw new Error("digest must not resolve the Revisor UI URL"); },
    });
    const res = await app.request("/v1/prs/revisor/digest");
    expect(res.status).toBe(200);
    const body = await res.json() as { markdown: string; error: string | null };
    expect(body.error).toBe("revisor_request_failed");
    expect(body.markdown).toContain("取得できませんでした");
    expect(body.markdown).not.toContain("ECONNREFUSED");
  });
});
