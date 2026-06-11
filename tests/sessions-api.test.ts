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

  it("POST /v1/sessions/:id/inject emits session.inject event + records inject kind", async () => {
    await app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "inj", provider: "claude-code", repo_path: "/x", host: "h" }),
    });
    const { eventBus } = await import("../src/events.js");
    const captured: any[] = [];
    const unsub = eventBus.subscribe((ev) => { if (ev.type === "session.inject") captured.push(ev); });
    try {
      const r = await app.request("/v1/sessions/inj/inject", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "do the thing", source: "test" }),
      });
      expect(r.status).toBe(200);
      expect(captured).toHaveLength(1);
      expect(captured[0]).toMatchObject({
        type: "session.inject",
        target_session_id: "inj",
        text: "do the thing",
        source: "test",
      });
    } finally {
      unsub();
    }

    const detail = await (await app.request("/v1/sessions/inj")).json() as any;
    const kinds = detail.events.map((e: any) => e.kind);
    expect(kinds).toContain("inject");
  });

  it("POST /v1/sessions/:id/title emits title_renamed (Lictor へは転送しない)", async () => {
    await app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "ti", provider: "claude-code", repo_path: "/x", host: "h" }),
    });
    const { eventBus } = await import("../src/events.js");
    const captured: any[] = [];
    const unsub = eventBus.subscribe((ev) => {
      if (ev.type === "session.event" && (ev as any).kind === "title_renamed") captured.push(ev);
    });
    try {
      const r = await app.request("/v1/sessions/ti/title", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "[Co] やる事" }),
      });
      expect(r.status).toBe(200);
      expect(captured).toHaveLength(1);
      expect(captured[0]).toMatchObject({ type: "session.event", session_id: "ti", kind: "title_renamed" });
    } finally {
      unsub();
    }
    const detail = await (await app.request("/v1/sessions/ti")).json() as any;
    const titleEv = detail.events.find((e: any) => e.kind === "title_renamed");
    const payload = typeof titleEv.payload === "string" ? JSON.parse(titleEv.payload) : titleEv.payload;
    expect(payload.text).toBe("[Co] やる事");
  });

  it("POST /v1/sessions/:id/title 空テキストは 400", async () => {
    await app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "ti2", provider: "claude-code", repo_path: "/x", host: "h" }),
    });
    const r = await app.request("/v1/sessions/ti2/title", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "" }),
    });
    expect(r.status).toBe(400);
  });

  it("POST /v1/sessions/:id/inject returns 404 for unknown session", async () => {
    const r = await app.request("/v1/sessions/nope/inject", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(r.status).toBe(404);
  });

  it("POST /v1/sessions/:id/transcript-frame emits a session-targeted transcript.frame event", async () => {
    await app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "tf", provider: "claude-code", repo_path: "/x", host: "h" }),
    });
    const { eventBus } = await import("../src/events.js");
    const captured: any[] = [];
    const unsub = eventBus.subscribe((ev) => { if (ev.type === "transcript.frame") captured.push(ev); });
    try {
      const r = await app.request("/v1/sessions/tf/transcript-frame", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ seq: 0, kind: "text", payload: { role: "assistant", text: "hi" } }),
      });
      expect(r.status).toBe(200);
      expect(captured).toHaveLength(1);
      expect(captured[0]).toMatchObject({
        type: "transcript.frame",
        target_session_id: "tf",
        seq: 0,
        kind: "text",
      });
    } finally {
      unsub();
    }
  });

  it("POST /v1/sessions/:id/transcript-frame returns 400 on bad payload", async () => {
    await app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "tf2", provider: "claude-code", repo_path: "/x", host: "h" }),
    });
    const r = await app.request("/v1/sessions/tf2/transcript-frame", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seq: -1, kind: "text", payload: {} }),
    });
    expect(r.status).toBe(400);
  });

  it("POST /v1/sessions/:id/inject returns 400 for empty text", async () => {
    await app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "inj2", provider: "claude-code", repo_path: "/x", host: "h" }),
    });
    const r = await app.request("/v1/sessions/inj2/inject", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "" }),
    });
    expect(r.status).toBe(400);
  });

  it("POST /v1/sessions/:id/title-suggestion: Lictor へ /v1/rename を転送する", async () => {
    // session を作って lictor_port を metadata に書き込む
    await app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "t1", provider: "claude-code", repo_path: "/x", host: "h",
        metadata: { lictor_port: 12345 },
      }),
    });

    // Lictor 側を fetch でモック
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: any, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true, sent: "サンプル" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as any;
    try {
      const r = await app.request("/v1/sessions/t1/title-suggestion", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "サンプル" }),
      });
      expect(r.status).toBe(200);
      const j = await r.json() as any;
      expect(j.ok).toBe(true);
      expect(j.lictor.ok).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("http://127.0.0.1:12345/v1/rename");
      const sent = JSON.parse(calls[0].init?.body as string);
      expect(sent.text).toBe("サンプル");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("POST /v1/sessions/:id/title-suggestion: lictor_port 未設定なら 404", async () => {
    await app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "t2", provider: "claude-code", repo_path: "/x", host: "h" }),
    });
    const r = await app.request("/v1/sessions/t2/title-suggestion", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "x" }),
    });
    expect(r.status).toBe(404);
  });

  it("POST /v1/sessions/:id/title-suggestion: 空テキストは 400", async () => {
    await app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "t3", provider: "claude-code", repo_path: "/x", host: "h",
        metadata: { lictor_port: 12345 },
      }),
    });
    const r = await app.request("/v1/sessions/t3/title-suggestion", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "" }),
    });
    expect(r.status).toBe(400);
  });

  describe("transcript persistence (v0.5)", () => {
    async function startSession(id = "t1", repo_path = "/p") {
      await app.request("/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, provider: "claude-code", repo_path, host: "h" }),
      });
    }

    async function postFrame(sessionId: string, seq: number, kind: string, payload: unknown) {
      return app.request(`/v1/sessions/${sessionId}/transcript-frame`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ seq, kind, payload }),
      });
    }

    it("POST /v1/sessions/:id/transcript-frame は永続化して persisted=true を返す", async () => {
      await startSession();
      const r = await postFrame("t1", 0, "text", { role: "user", text: "hello" });
      expect(r.status).toBe(200);
      const j = (await r.json()) as { ok: boolean; persisted: boolean };
      expect(j.ok).toBe(true);
      expect(j.persisted).toBe(true);
    });

    it("同 seq の重複 POST は persisted=false を返す (冪等)", async () => {
      await startSession();
      await postFrame("t1", 0, "text", { role: "user", text: "first" });
      const r = await postFrame("t1", 0, "text", { role: "user", text: "second" });
      const j = (await r.json()) as { ok: boolean; persisted: boolean };
      expect(j.ok).toBe(true);
      expect(j.persisted).toBe(false);
    });

    it("GET /v1/sessions/:id/transcript は ts ASC で全件返し total + next_since_id を含む", async () => {
      await startSession();
      await postFrame("t1", 0, "text", { role: "user", text: "u1" });
      await postFrame("t1", 1, "tool-use", { role: "assistant", name: "Bash" });
      await postFrame("t1", 2, "tool-result", { tool_use_id: "x", is_error: false });
      const r = await app.request("/v1/sessions/t1/transcript");
      expect(r.status).toBe(200);
      const j = (await r.json()) as {
        session_id: string;
        total: number;
        entries: Array<{ id: number; seq: number; kind: string; payload: unknown }>;
        next_since_id: number;
      };
      expect(j.session_id).toBe("t1");
      expect(j.total).toBe(3);
      expect(j.entries.map((e) => e.seq)).toEqual([0, 1, 2]);
      expect(j.entries.map((e) => e.kind)).toEqual(["text", "tool-use", "tool-result"]);
      expect(j.next_since_id).toBe(j.entries[2].id);
    });

    it("GET ?since_id=N は incremental tail (それより新しい行のみ)", async () => {
      await startSession();
      for (let i = 0; i < 4; i++) await postFrame("t1", i, "text", { role: "user", text: `m${i}` });
      const r1 = await app.request("/v1/sessions/t1/transcript?limit=2");
      const j1 = (await r1.json()) as { entries: Array<{ id: number }>; next_since_id: number };
      const r2 = await app.request(`/v1/sessions/t1/transcript?since_id=${j1.next_since_id}`);
      const j2 = (await r2.json()) as { entries: Array<{ seq: number }> };
      expect(j2.entries.map((e) => e.seq)).toEqual([2, 3]);
    });

    it("不在 session への transcript POST / GET は 404", async () => {
      const r1 = await postFrame("nonexistent", 0, "text", { x: 1 });
      expect(r1.status).toBe(404);
      const r2 = await app.request("/v1/sessions/nonexistent/transcript");
      expect(r2.status).toBe(404);
    });

    it("不正 body は 400 (zod validation)", async () => {
      await startSession();
      const r = await app.request("/v1/sessions/t1/transcript-frame", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "text" }), // seq 欠落
      });
      expect(r.status).toBe(400);
    });
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

  describe("pending-question / answer-question", () => {
    it("POST pending-question stores row + emits question.posted", async () => {
      await app.request("/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "pq", provider: "claude-code", repo_path: "/x", host: "h" }),
      });
      const { eventBus } = await import("../src/events.js");
      const hits: any[] = [];
      const unsub = eventBus.subscribe((ev) => { if (ev.type === "question.posted") hits.push(ev); });
      try {
        const r = await app.request("/v1/sessions/pq/pending-question", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ question: "Pick one", options: ["A", "B"] }),
        });
        expect(r.status).toBe(200);
        const j = await r.json() as any;
        expect(j.ok).toBe(true);
        expect(j.question_id).toBeGreaterThan(0);
        expect(hits).toHaveLength(1);
      } finally {
        unsub();
      }
    });

    it("POST answer-question answers once and second try is 409", async () => {
      await app.request("/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "aq", provider: "claude-code", repo_path: "/x", host: "h" }),
      });
      const qRes = await app.request("/v1/sessions/aq/pending-question", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "Pick one", options: ["A", "B"] }),
      });
      const q = await qRes.json() as any;
      const r1 = await app.request("/v1/sessions/aq/answer-question", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question_id: q.question_id, answer_index: 1 }),
      });
      expect(r1.status).toBe(200);
      const j1 = await r1.json() as any;
      expect(j1.answer_text).toBe("B");

      const r2 = await app.request("/v1/sessions/aq/answer-question", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question_id: q.question_id, answer_index: 0 }),
      });
      expect(r2.status).toBe(409);
    });
  });

  describe("GET /v1/sessions/:id/discord-channels", () => {
    it("returns null session channel when none created, meta channels from config", async () => {
      const env = makeTestApp();
      // discord_config に meta channel を仕込む
      env.discordConfig.set("chitchat_channel_id", "111");
      env.discordConfig.set("consultation_channel_id", "222");
      const localApp = env.app;
      await localApp.request("/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "ds", provider: "claude-code", repo_path: "/x", host: "h" }),
      });
      const res = await localApp.request("/v1/sessions/ds/discord-channels");
      expect(res.status).toBe(200);
      const j = await res.json() as any;
      expect(j.ok).toBe(true);
      expect(j.session_channel_id).toBe(null); // channel 未作成
      expect(j.meta_channels.chitchat).toBe("111");
      expect(j.meta_channels.consultation).toBe("222");
      expect(j.meta_channels.system).toBe(null);
    });

    it("returns the session channel id once a row exists", async () => {
      const env = makeTestApp();
      const channels = env.discordChannels;
      const localApp = env.app;
      await localApp.request("/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "ds2", provider: "claude-code", repo_path: "/x", host: "h" }),
      });
      channels.upsert({ session_id: "ds2", channel_id: "999", status: "active" });
      const res = await localApp.request("/v1/sessions/ds2/discord-channels");
      const j = await res.json() as any;
      expect(j.session_channel_id).toBe("999");
      expect(j.session_channel_status).toBe("active");
    });

    it("404 for unknown session", async () => {
      const res = await app.request("/v1/sessions/nope/discord-channels");
      expect(res.status).toBe(404);
    });
  });
});
