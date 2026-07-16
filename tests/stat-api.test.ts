import { describe, it, expect, beforeEach } from "vitest";
import type { SessionsRepo } from "../src/db/sessions-repo.js";
import { makeTestApp } from "./helpers/test-app.js";

function makeApp() {
  return makeTestApp({ rng: () => 0.99 });
}

function startSession(repo: SessionsRepo, id: string, opts: { branch?: string | null; repo_path?: string } = {}) {
  repo.insertSession({
    id, provider: "claude-code",
    repo_path: opts.repo_path ?? "/abs/Concordia",
    repo_origin: "github:LUDIARS/Concordia",
    branch: opts.branch === null ? null : (opts.branch ?? "main"),
    host: "h",
    started_at: 1, last_seen_at: Math.floor(Date.now() / 1000),
    transcript_path: null, metadata: null,
  });
}

describe("/v1/stat", () => {
  let env: ReturnType<typeof makeApp>;
  beforeEach(() => { env = makeApp(); });

  it("POST /v1/stat/:id stores stat and GET returns it", async () => {
    startSession(env.repo, "sess-a");
    const post = await env.app.request("/v1/stat/sess-a", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        payload: {
          active_repos: [{ repo: "Concordia", branch: "main", uncommitted: 0, unpushed: 0 }],
          recent_work: "schema v9 追加",
        },
      }),
    });
    expect(post.status).toBe(200);

    const get = await env.app.request("/v1/stat/sess-a");
    expect(get.status).toBe(200);
    const body = await get.json() as any;
    expect(body.latest.payload.recent_work).toBe("schema v9 追加");
    expect(body.history).toHaveLength(1);
    expect(body.session.id).toBe("sess-a");
  });

  it("POST /v1/stat/:id rejects unknown session", async () => {
    const r = await env.app.request("/v1/stat/missing", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: { recent_work: "x" } }),
    });
    expect(r.status).toBe(404);
  });

  it("GET /v1/stat lists latest per session (cross-session visibility)", async () => {
    startSession(env.repo, "sess-a");
    startSession(env.repo, "sess-b");
    env.stats.insert({ session_id: "sess-a", ts: 100, payload: { recent_work: "A1" } });
    env.stats.insert({ session_id: "sess-a", ts: 200, payload: { recent_work: "A2" } });
    env.stats.insert({ session_id: "sess-b", ts: 150, payload: { recent_work: "B1" } });

    const r = await env.app.request("/v1/stat");
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body.items).toHaveLength(2);
    const a = body.items.find((i: any) => i.session_id === "sess-a");
    expect(a.payload.recent_work).toBe("A2");
    expect(a.session?.id).toBe("sess-a");
  });
});

describe("/v1/monitor/conflicts (同一ブランチでない限り衝突しない)", () => {
  let env: ReturnType<typeof makeApp>;
  beforeEach(() => { env = makeApp(); });

  it("returns repo overview but conflicts only for matching branch (caller branch=null)", async () => {
    // caller 側 (= 呼び出し session) は branch 未指定 (null). repo 内の 3 session のうち
    // branch=null は 1 件のみ → conflicts に出るのは 1 件。 他は branches[] で見せるだけ.
    startSession(env.repo, "a", { branch: "feat/x", repo_path: "/abs/Concordia" });
    startSession(env.repo, "b", { branch: "main",   repo_path: "/abs/Concordia" });
    startSession(env.repo, "n", { branch: null as any, repo_path: "/abs/Concordia" });
    startSession(env.repo, "c", { branch: "main",   repo_path: "/abs/Other" });

    const r = await env.app.request("/v1/monitor/conflicts?repo=/abs/Concordia");
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body.conflicts.map((s: any) => s.id)).toEqual(["n"]);
    // branches[] は repo 全体 (caller branch に依らず) を集計
    expect(body.branches.map((b: any) => b.branch).sort()).toEqual(["(detached)", "feat/x", "main"]);
  });

  it("matches by repo_origin too — caller branch 一致時のみ", async () => {
    startSession(env.repo, "a", { branch: "feat/x", repo_path: "/abs/Concordia" });
    const r1 = await env.app.request("/v1/monitor/conflicts?repo=github:LUDIARS/Concordia&branch=feat/x");
    const body1 = await r1.json() as any;
    expect(body1.conflicts).toHaveLength(1);

    // branch 違いなら conflicts は空、 ただし branches[] には載る
    const r2 = await env.app.request("/v1/monitor/conflicts?repo=github:LUDIARS/Concordia&branch=main");
    const body2 = await r2.json() as any;
    expect(body2.conflicts).toHaveLength(0);
    expect(body2.branches.map((b: any) => b.branch)).toEqual(["feat/x"]);
  });

  it("filters by branch when given", async () => {
    startSession(env.repo, "a", { branch: "feat/x", repo_path: "/abs/Concordia" });
    startSession(env.repo, "b", { branch: "main",   repo_path: "/abs/Concordia" });
    const r = await env.app.request("/v1/monitor/conflicts?repo=/abs/Concordia&branch=feat/x");
    const body = await r.json() as any;
    expect(body.conflicts).toHaveLength(1);
    expect(body.conflicts[0].id).toBe("a");
  });

  it("異ブランチは衝突しない: branch=main + 相手 branch=feat/x は conflicts[] に出ない", async () => {
    startSession(env.repo, "self", { branch: "main", repo_path: "/abs/Concordia" });
    startSession(env.repo, "other", { branch: "feat/x", repo_path: "/abs/Concordia" });
    const r = await env.app.request(
      "/v1/monitor/conflicts?repo=/abs/Concordia&branch=main&exclude_session=self",
    );
    const body = await r.json() as any;
    expect(body.conflicts).toHaveLength(0);
    // branches[] は exclude_session 除外後の repo 集計
    expect(body.branches.map((b: any) => b.branch)).toEqual(["feat/x"]);
  });

  it("excludes session via exclude_session param", async () => {
    startSession(env.repo, "self", { branch: "feat/x", repo_path: "/abs/Concordia" });
    startSession(env.repo, "other", { branch: "feat/x", repo_path: "/abs/Concordia" });
    const r = await env.app.request(
      "/v1/monitor/conflicts?repo=/abs/Concordia&branch=feat/x&exclude_session=self",
    );
    const body = await r.json() as any;
    expect(body.conflicts).toHaveLength(1);
    expect(body.conflicts[0].id).toBe("other");
  });

  it("returns 400 when repo param missing", async () => {
    const r = await env.app.request("/v1/monitor/conflicts");
    expect(r.status).toBe(400);
  });

  it("does not treat the umbrella workspace root as a work target or conflict scope", async () => {
    env.adminState.setWorkspaceRoot("E:/Document/Ars");
    startSession(env.repo, "root-a", { branch: "main", repo_path: "E:\\Document\\Ars" });
    startSession(env.repo, "root-b", { branch: "fix/other", repo_path: "E:/Document/Ars/" });

    const r = await env.app.request("/v1/monitor/conflicts?repo=E%3A%2FDocument%2FArs&branch=main");
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body.workspace_root).toBe(true);
    expect(body.conflicts).toEqual([]);
    expect(body.branches).toEqual([]);
  });
});
