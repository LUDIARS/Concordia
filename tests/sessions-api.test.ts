import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp } from "./helpers/test-app.js";

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
    expect(j.report.summary_md).toContain("Session z");
    expect(j.report.bullets).toBeTruthy();
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
});
