import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp } from "./helpers/test-app.js";

function buildTestApp() {
  return makeTestApp().app;
}

describe("sessions API — transcript", () => {
  let app: ReturnType<typeof buildTestApp>;
  beforeEach(() => { app = buildTestApp(); });

  it("POST /v1/sessions/:id/transcript-frame emits a session-targeted transcript.frame event", async () => {
    // emit は「active session + active Discord channel 紐付け」 のときだけ
    // (33f3a7f: inactive relay 抑制)。 テストでも紐付けを作ってから叩く。
    const env = makeTestApp();
    await env.app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "tf", provider: "claude-code", repo_path: "/x", host: "h" }),
    });
    env.discordChannels.upsert({ session_id: "tf", channel_id: "ch-tf", status: "active" });
    const { eventBus } = await import("../src/events.js");
    const captured: any[] = [];
    const unsub = eventBus.subscribe((ev) => { if (ev.type === "transcript.frame") captured.push(ev); });
    try {
      const r = await env.app.request("/v1/sessions/tf/transcript-frame", {
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

  it("Discord channel 紐付けが無い session の frame は relay emit せず message 投影する", async () => {
    const env = makeTestApp();
    await env.app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "tf-nb", provider: "claude-code", repo_path: "/x", host: "h" }),
    });
    const { eventBus } = await import("../src/events.js");
    const captured: any[] = [];
    const unsub = eventBus.subscribe((ev) => { if (ev.type === "transcript.frame") captured.push(ev); });
    try {
      const r = await env.app.request("/v1/sessions/tf-nb/transcript-frame", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ seq: 0, kind: "text", payload: { role: "assistant", text: "hi" } }),
      });
      expect(r.status).toBe(200);
      const body = await r.json() as { persisted: boolean; inactive?: boolean };
      expect(body.persisted).toBe(true);
      expect(body.inactive).toBe(true);
      expect(captured).toHaveLength(0);
      expect(env.sessionMessages.list("tf-nb")).toMatchObject([{
        content: "hi",
        dedupe_key: "frame:0",
      }]);
    } finally {
      unsub();
    }
  });

  it("does not persist, project, or emit thinking frames while the setting is disabled", async () => {
    const env = makeTestApp();
    await env.app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "tf-thinking", provider: "claude-code", repo_path: "/x", host: "h" }),
    });
    env.discordChannels.upsert({ session_id: "tf-thinking", channel_id: "ch-thinking", status: "active" });
    const { eventBus } = await import("../src/events.js");
    const captured: unknown[] = [];
    const unsub = eventBus.subscribe((ev) => { if (ev.type === "transcript.frame") captured.push(ev); });
    try {
      const response = await env.app.request("/v1/sessions/tf-thinking/transcript-frame", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ seq: 0, kind: "thinking", payload: { text: "private reasoning" } }),
      });
      expect(await response.json()).toMatchObject({ ok: true, persisted: false, suppressed: true });
      expect(captured).toHaveLength(0);
      expect(env.transcriptLogs.listBySession("tf-thinking")).toHaveLength(0);
      expect(env.sessionMessages.list("tf-thinking")).toHaveLength(0);
    } finally {
      unsub();
    }
  });

  it("relays thinking frames after the setting is enabled", async () => {
    const env = makeTestApp();
    env.adminState.setThinkingMessagesEnabled(true);
    await env.app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "tf-thinking-enabled", provider: "claude-code", repo_path: "/x", host: "h" }),
    });
    const response = await env.app.request("/v1/sessions/tf-thinking-enabled/transcript-frame", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seq: 0, kind: "thinking", payload: { text: "deliberate" } }),
    });
    expect(await response.json()).toMatchObject({ ok: true, persisted: true, suppressed: false });
    expect(env.transcriptLogs.listBySession("tf-thinking-enabled")).toHaveLength(1);
    expect(env.sessionMessages.list("tf-thinking-enabled")).toHaveLength(1);
  });

  it("inactive relay projection shares tool correlation state with the lifecycle projector", async () => {
    const env = makeTestApp();
    await env.app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "tf-shared", provider: "claude-code", repo_path: "/x", host: "h" }),
    });
    const postFrame = (seq: number, kind: string, payload: unknown) => env.app.request(
      "/v1/sessions/tf-shared/transcript-frame",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ seq, kind, payload }),
      },
    );

    // First inactive frame initializes the route-facing context.
    await postFrame(0, "tool-use", {
      name: "Task",
      tool_use_id: "task-old",
      task: { subagent_type: "Explore", description: "old" },
    });
    // This event represents an active-relay frame received through the lifecycle subscription.
    env.projectSessionEvent({
      type: "transcript.frame",
      target_session_id: "tf-shared",
      seq: 1,
      kind: "tool-use",
      payload: {
        name: "Task",
        tool_use_id: "task-new",
        task: { subagent_type: "Explore", description: "new" },
      },
      ts: 2,
    });
    await postFrame(2, "tool-result", {
      tool_use_id: "task-new",
      is_error: false,
      preview: "done",
    });

    const messages = env.sessionMessages.list("tf-shared");
    expect(messages).toHaveLength(2);
    expect(messages.find((message) => message.dedupe_key === "task:task-new"))
      .toMatchObject({ content: "done" });
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

    it("同 seq の重複 POST は persisted=true を返す (冪等成功・行は増えない)", async () => {
      // Lictor sink は timeout 後に同 seq で再送する (at-least-once)。 重複を
      // persisted=false で返すと requirePersisted な書き手が死ぬ (2026-07-12 実障害)。
      await startSession();
      await postFrame("t1", 0, "text", { role: "user", text: "first" });
      const r = await postFrame("t1", 0, "text", { role: "user", text: "second" });
      const j = (await r.json()) as { ok: boolean; persisted: boolean };
      expect(j.ok).toBe(true);
      expect(j.persisted).toBe(true);
      // 先勝ちで 1 行のまま (上書きされない)。
      const tr = await app.request("/v1/sessions/t1/transcript");
      const tj = (await tr.json()) as { total: number; entries: Array<{ payload: { text: string } }> };
      expect(tj.total).toBe(1);
      expect(tj.entries[0].payload).toEqual({ role: "user", text: "first" });
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

  // ログ閲覧の改善: tail (最新を表示) と、 sweeper purge 済みセッションの閲覧.
  describe("transcript log viewing", () => {
    it("?tail=1 は最新 limit 件を時系列 (ASC) で返す", async () => {
      const env = makeTestApp();
      await env.app.request("/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "tl", provider: "claude-code", repo_path: "/p", host: "h" }),
      });
      for (let i = 0; i < 5; i++) {
        await env.app.request("/v1/sessions/tl/transcript-frame", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ seq: i, kind: "text", payload: { text: `m${i}` } }),
        });
      }
      // tail 無し = 先頭 2 件 (従来契約).
      const head = await env.app.request("/v1/sessions/tl/transcript?limit=2");
      expect(((await head.json()) as { entries: Array<{ seq: number }> }).entries.map((e) => e.seq)).toEqual([0, 1]);
      // tail=1 = 最新 2 件を時系列順で.
      const tail = await env.app.request("/v1/sessions/tl/transcript?tail=1&limit=2");
      expect(((await tail.json()) as { entries: Array<{ seq: number }> }).entries.map((e) => e.seq)).toEqual([3, 4]);
    });

    it("sessions 行が無くても transcript_logs があれば閲覧でき synthetic session を返す", async () => {
      const env = makeTestApp();
      // sessions 行は作らず purge 済み相当の孤児 transcript を直接 seed.
      env.transcriptLogs.insert({ session_id: "orphan", seq: 0, ts: 1000, kind: "text", payload: { text: "a" } });
      env.transcriptLogs.insert({ session_id: "orphan", seq: 1, ts: 1001, kind: "text", payload: { text: "b" } });

      const rt = await env.app.request("/v1/sessions/orphan/transcript");
      expect(rt.status).toBe(200);
      const jt = (await rt.json()) as { total: number; entries: Array<{ seq: number }> };
      expect(jt.total).toBe(2);
      expect(jt.entries.map((e) => e.seq)).toEqual([0, 1]);

      const rs = await env.app.request("/v1/sessions/orphan");
      expect(rs.status).toBe(200);
      const js = (await rs.json()) as {
        session: { id: string; status: string; metadata: { purged?: boolean } | null };
        events: unknown[];
      };
      expect(js.session.id).toBe("orphan");
      expect(js.session.status).toBe("abandoned");
      expect(js.session.metadata?.purged).toBe(true);
      expect(js.events).toEqual([]);
    });
  });
});
