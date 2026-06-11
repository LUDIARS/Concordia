import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp } from "./helpers/test-app.js";

function buildTestApp() {
  return makeTestApp().app;
}

describe("sessions API — inject / title / title-suggestion", () => {
  let app: ReturnType<typeof buildTestApp>;
  beforeEach(() => { app = buildTestApp(); });

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
});
