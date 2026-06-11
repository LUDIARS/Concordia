import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp } from "./helpers/test-app.js";

function buildTestApp() {
  return makeTestApp().app;
}

describe("sessions API — transcript", () => {
  let app: ReturnType<typeof buildTestApp>;
  beforeEach(() => { app = buildTestApp(); });

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
});
