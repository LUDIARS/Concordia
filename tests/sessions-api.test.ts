import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp } from "./helpers/test-app.js";
import { recordPendingDelegationSpawn } from "../src/control/pending-delegation-spawns.js";

function buildTestApp() {
  return makeTestApp().app;
}

describe("sessions API", () => {
  let app: ReturnType<typeof buildTestApp>;
  beforeEach(() => { app = buildTestApp(); });

  it("POST /v1/sessions creates and returns peers/advisory", async () => {
    const body1 = {
      id: "a", provider: "claude-code", repo_path: "/x",
      repo_origin: "origin", host: "h", branch: "main",
    };
    const r1 = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body1),
    });
    expect(r1.status).toBe(200);

    const body2 = { ...body1, id: "b" };
    const r2 = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body2),
    });
    const j2 = await r2.json() as any;
    expect(j2.peers).toHaveLength(1);
    expect(j2.peers[0].id).toBe("a");
    expect(j2.advisory.branch_conflict).toBe(true);
    expect(j2.advisory.recommend_worktree).toBe(true);
    expect(typeof j2.advisory.worktree_command).toBe("string");
  });

  it.each(["provided", "omitted"] as const)(
    "Cc spawn metadata records the mandatory Session work-policy inject (%s)",
    async (cwdMode) => {
      const id = `spawn-${cwdMode}`;
      recordPendingDelegationSpawn({
        cwd: "/workspace/Castra",
        spawnId: `cc-${cwdMode}`,
        callName: "sessions-api-test",
      });
      const start = await app.request("/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id,
          provider: "codex-cli",
          repo_path: "/workspace/Castra",
          host: "h",
          metadata: {
            concordia_spawn_id: `cc-${cwdMode}`,
            concordia_spawn_cwd_mode: cwdMode,
          },
        }),
      });
      expect(start.status).toBe(200);

      const detail = await app.request(`/v1/sessions/${id}`);
      const body = (await detail.json()) as {
        events: Array<{ kind: string; payload: Record<string, unknown> }>;
      };
      const inject = body.events.find(
        (event) => event.kind === "inject" &&
          event.payload.source === "cc-session-work-policy",
      );
      expect(inject?.payload.text).toContain("作業対象プロジェクトを最初に特定");
      expect(inject?.payload.text).toContain("Castra (workspace root) を cwd にした横断作業");
    },
  );

  it("event append + recent events", async () => {
    await app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "x", provider: "claude-code", repo_path: "/x", host: "h",
      }),
    });
    const ev = await app.request("/v1/sessions/x/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "prompt", payload: { summary: "test" } }),
    });
    expect(ev.status).toBe(200);
    const detail = await app.request("/v1/sessions/x");
    const j = await detail.json() as any;
    expect(j.events.length).toBeGreaterThanOrEqual(2); // start + prompt
    expect(j.events[0].kind).toBe("prompt");
  });

  it("prompt event auto-updates current_task from summary", async () => {
    await app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "ct", provider: "claude-code", repo_path: "/x", host: "h",
      }),
    });
    await app.request("/v1/sessions/ct/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "prompt", payload: { summary: "current task summary text" } }),
    });
    const detail = await app.request("/v1/sessions/ct");
    const j = await detail.json() as any;
    expect(j.session.current_task).toBe("current task summary text");

    // 後続 prompt で上書きされる
    await app.request("/v1/sessions/ct/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "prompt", payload: { summary: "second task" } }),
    });
    const d2 = await app.request("/v1/sessions/ct");
    const j2 = await d2.json() as any;
    expect(j2.session.current_task).toBe("second task");

    // edit event は current_task を変えない
    await app.request("/v1/sessions/ct/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "edit", payload: { file: "x.ts" } }),
    });
    const d3 = await app.request("/v1/sessions/ct");
    const j3 = await d3.json() as any;
    expect(j3.session.current_task).toBe("second task");
  });

  it("DELETE /v1/sessions/:id ends session + 独立した per-session report 生成", async () => {
    await app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "z", provider: "claude-code", repo_path: "/x", host: "h",
      }),
    });
    await app.request("/v1/sessions/z/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "edit", payload: { file: "src/foo.ts" } }),
    });
    const r = await app.request("/v1/sessions/z", { method: "DELETE" });
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j.session.status).toBe("ended");
    expect(j.session.metadata.session_end_pending_at).toEqual(expect.any(Number));
    expect(j.report.summary_md).toContain("Session z");
    expect(j.report.bullets).toBeTruthy();

    const done = await app.request("/v1/sessions/z/session-end-done", { method: "POST" });
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ ok: true, stop: { stopped: [], failed: [] } });
    const detail = await (await app.request("/v1/sessions/z")).json() as any;
    expect(detail.session.metadata.session_end_pending_at).toBeUndefined();
  });

  it("session-end-done without a pending end does not stop an active session", async () => {
    await app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "not-ending", provider: "codex-cli", repo_path: "/x", host: "h",
        metadata: { lictor_pid: 999_999 },
      }),
    });

    const done = await app.request("/v1/sessions/not-ending/session-end-done", { method: "POST" });
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ ok: true, ignored: true });
    const detail = await (await app.request("/v1/sessions/not-ending")).json() as any;
    expect(detail.session.status).toBe("active");
  });

  it("PATCH updates current_task", async () => {
    await app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "p", provider: "claude-code", repo_path: "/x", host: "h",
      }),
    });
    const r = await app.request("/v1/sessions/p", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ current_task: "doing X" }),
    });
    expect(r.status).toBe(200);
    const detail = await (await app.request("/v1/sessions/p")).json() as any;
    expect(detail.session.current_task).toBe("doing X");
  });

  it("keeps an explicit child binding when a Castra-rooted session reports root state again", async () => {
    const env = makeTestApp();
    env.adminState.setWorkspaceRoots(["E:/Document/Ars"]);
    const root = "E:/Document/Ars";
    const worktree = "E:/Document/Ars/.wt-Concordia-card";
    const branch = "codex/concordia-card";

    await env.app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "root-bound", provider: "codex-cli", repo_path: root, host: "h", branch: "main" }),
    });
    await env.app.request("/v1/sessions/root-bound", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo_path: worktree,
        repo_origin: "git@github.com:LUDIARS/Concordia.git",
        target_project: "E:/Document/Ars/Concordia",
        branch,
      }),
    });
    await env.app.request("/v1/sessions/root-bound/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "lictor.task.changed", payload: { source: "explicit", branch } }),
    });

    const rootUpdate = await env.app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "root-bound", provider: "codex-cli", repo_path: root, repo_origin: null,
        target_project: null, host: "h", branch: "main",
      }),
    });
    expect(rootUpdate.status).toBe(200);

    const session = env.repo.findSession("root-bound");
    expect(session).toMatchObject({
      repo_path: worktree,
      repo_origin: "git@github.com:LUDIARS/Concordia.git",
      target_project: "E:/Document/Ars/Concordia",
      branch,
    });

    const patchRootUpdate = await env.app.request("/v1/sessions/root-bound", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo_path: root, repo_origin: null, target_project: null, branch: "main" }),
    });
    expect(patchRootUpdate.status).toBe(200);
    expect(env.repo.findSession("root-bound")).toMatchObject({
      repo_path: worktree,
      repo_origin: "git@github.com:LUDIARS/Concordia.git",
      target_project: "E:/Document/Ars/Concordia",
      branch,
    });

    // The automatic event can arrive after a root-derived branch update. It
    // must restore the branch explicitly claimed for the child worktree.
    env.repo.patchSession("root-bound", { branch: "main" });
    const automaticTaskChange = await env.app.request("/v1/sessions/root-bound/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "lictor.task.changed", payload: { source: "auto", branch: "main" } }),
    });
    expect(automaticTaskChange.status).toBe(200);
    expect(env.repo.findSession("root-bound")?.branch).toBe(branch);
  });

  it("404 for unknown session", async () => {
    const r = await app.request("/v1/sessions/nope");
    expect(r.status).toBe(404);
  });

  it("PATCH /v1/sessions/:id metadata merges shallowly", async () => {
    await app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "meta-merge",
        provider: "claude-code",
        repo_path: "/x",
        host: "h",
        metadata: { existing_key: "kept", lictor_pid: 1234 },
      }),
    });
    const r = await app.request("/v1/sessions/meta-merge", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ metadata: { lictor_port: 51234, lictor_pid: null } }),
    });
    expect(r.status).toBe(200);
    const detail = (await (await app.request("/v1/sessions/meta-merge")).json()) as any;
    expect(detail.session.metadata.existing_key).toBe("kept");
    expect(detail.session.metadata.lictor_port).toBe(51234);
    expect(detail.session.metadata.lictor_pid).toBeUndefined(); // null deleted it
  });

  it("GET /v1/sessions can filter by subsidiary_id without returning head-office sessions", async () => {
    await app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "head",
        provider: "claude-code",
        repo_path: "/x",
        host: "h",
      }),
    });
    await app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "sub",
        provider: "claude-code",
        repo_path: "/x",
        host: "h",
        metadata: { subsidiary_id: "sub-1" },
      }),
    });

    const r = await app.request("/v1/sessions?subsidiary_id=sub-1");
    const body = (await r.json()) as any;
    expect(body.sessions.map((s: any) => s.id)).toEqual(["sub"]);
  });

  describe("POST /v1/sessions/:id/request-stat / request-title — 手動 enqueue", () => {
    async function startReqSession(id = "rq1") {
      const r = await app.request("/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, provider: "claude-code", repo_path: "/r", host: "h" }),
      });
      expect(r.status).toBe(200);
    }

    it("request-stat: stat-collect task を enqueue する (trigger=manual)", async () => {
      await startReqSession("rq1");
      const r = await app.request("/v1/sessions/rq1/request-stat", { method: "POST" });
      expect(r.status).toBe(200);
      const j = (await r.json()) as { ok: boolean; enqueued: boolean };
      expect(j.enqueued).toBe(true);
      const pendRes = await app.request("/v1/sessions/rq1/pending-tasks");
      const p = (await pendRes.json()) as {
        tasks: Array<{ kind: string; payload: { trigger?: string } }>;
      };
      const stat = p.tasks.find((t) => t.kind === "stat-collect");
      expect(stat).toBeTruthy();
      expect(stat!.payload.trigger).toBe("manual");
    });

    it("request-stat: 未配信 stat-collect があれば no-op で 200 を返す", async () => {
      await startReqSession("rq2");
      const r1 = await app.request("/v1/sessions/rq2/request-stat", { method: "POST" });
      expect(((await r1.json()) as { enqueued: boolean }).enqueued).toBe(true);
      const r2 = await app.request("/v1/sessions/rq2/request-stat", { method: "POST" });
      const j2 = (await r2.json()) as { ok: boolean; enqueued: boolean; reason?: string };
      expect(j2.enqueued).toBe(false);
      expect(j2.reason).toBe("already_pending");
    });

    it("request-title: title-suggest task を enqueue する (reason=manual)", async () => {
      await startReqSession("rq3");
      const r = await app.request("/v1/sessions/rq3/request-title", { method: "POST" });
      expect(r.status).toBe(200);
      const pendRes = await app.request("/v1/sessions/rq3/pending-tasks");
      const p = (await pendRes.json()) as {
        tasks: Array<{ kind: string; payload: { reason?: string } }>;
      };
      const t = p.tasks.find((x) => x.kind === "title-suggest");
      expect(t).toBeTruthy();
      expect(t!.payload.reason).toBe("manual");
    });

    it("request-stat / request-title: 不在 session は 404", async () => {
      const r1 = await app.request("/v1/sessions/nope/request-stat", { method: "POST" });
      expect(r1.status).toBe(404);
      const r2 = await app.request("/v1/sessions/nope/request-title", { method: "POST" });
      expect(r2.status).toBe(404);
    });
  });

  // lost に落ちた健全セッションが生きた traffic で active に戻ること (revive)。
  // 従来は SessionStart しか復帰経路がなく、 lost 固定 → purge → reaper 誤 kill の
  // 連鎖が起きていた (spec/plan/problems/cc-stability-problems.md B-1)。
  describe("lost session revival", () => {
    async function startLostSession(env: ReturnType<typeof makeTestApp>, id: string) {
      await env.app.request("/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, provider: "claude-code", repo_path: "/x", host: "h" }),
      });
      env.repo.setStatus(id, "lost", 10);
      expect(env.repo.findSession(id)?.status).toBe("lost");
    }

    it("POST /event revives a lost session to active and records a revive event", async () => {
      const env = makeTestApp();
      await startLostSession(env, "rv1");
      const r = await env.app.request("/v1/sessions/rv1/event", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "prompt", payload: { summary: "still here" } }),
      });
      expect(r.status).toBe(200);
      expect(env.repo.findSession("rv1")?.status).toBe("active");
      const kinds = env.repo.recentEvents("rv1", 10).map((e) => e.kind);
      expect(kinds).toContain("revive");
    });

    it("POST /heartbeat revives a lost session to active", async () => {
      const env = makeTestApp();
      await startLostSession(env, "rv2");
      const r = await env.app.request("/v1/sessions/rv2/heartbeat", { method: "POST" });
      expect(r.status).toBe(200);
      expect(env.repo.findSession("rv2")?.status).toBe("active");
    });

    it("PATCH revives a lost session to active", async () => {
      const env = makeTestApp();
      await startLostSession(env, "rv3");
      const r = await env.app.request("/v1/sessions/rv3", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ current_task: "working" }),
      });
      expect(r.status).toBe(200);
      expect(env.repo.findSession("rv3")?.status).toBe("active");
    });

    it("ended sessions are NOT revived by traffic", async () => {
      const env = makeTestApp();
      await env.app.request("/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "rv4", provider: "claude-code", repo_path: "/x", host: "h" }),
      });
      env.repo.setStatus("rv4", "ended", 10, 10);
      await env.app.request("/v1/sessions/rv4/heartbeat", { method: "POST" });
      expect(env.repo.findSession("rv4")?.status).toBe("ended");
    });
  });
});
