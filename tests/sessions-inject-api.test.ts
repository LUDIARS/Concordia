import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeTestApp } from "./helpers/test-app.js";
import type { TestAppEnv } from "./helpers/test-app.js";

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

  it("起動時にゴール起点の session.inject を遅延 emit する (旧branch picker廃止)", async () => {
    const { eventBus } = await import("../src/events.js");
    const captured: any[] = [];
    const unsub = eventBus.subscribe((ev) => {
      if (ev.type === "session.inject" && ev.target_session_id === "iw") captured.push(ev);
    });
    vi.useFakeTimers();
    try {
      const r = await app.request("/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "iw", provider: "claude-code", repo_path: "/repos/Anatomia", host: "h" }),
      });
      expect(r.status).toBe(200);
      // 起点 inject は picker キーストローク fallback の後に届くよう遅延 emit する
      expect(captured).toHaveLength(0);
      vi.advanceTimersByTime(600);
      expect(captured).toHaveLength(1);
      expect(captured[0].source).toBe("auto:goal-start");
      expect(captured[0].text).toContain("完成まで実装");
      expect(captured[0].text).toContain("/co-goal");
    } finally {
      vi.useRealTimers();
      unsub();
    }

    // inject イベントが session に記録されている (同期)
    const detail = await (await app.request("/v1/sessions/iw")).json() as any;
    const injectEv = detail.events.find((e: any) => e.kind === "inject");
    expect(injectEv).toBeTruthy();
    const payload = typeof injectEv.payload === "string" ? JSON.parse(injectEv.payload) : injectEv.payload;
    expect(payload.source).toBe("auto:goal-start");
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

describe("sessions API — inject participants upsert 分岐", () => {
  let env: TestAppEnv;
  beforeEach(() => {
    env = makeTestApp();
    // セッション "pinj" を作成しておく
  });

  async function createSession(id: string) {
    await env.app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, provider: "claude-code", repo_path: "/x", host: "h" }),
    });
  }

  it('source="discord:123" + author_label 付きで inject → participants に 1 件 upsert される', async () => {
    await createSession("pinj1");
    const r = await env.app.request("/v1/sessions/pinj1/inject", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello", source: "discord:123", author_label: "Taro" }),
    });
    expect(r.status).toBe(200);
    const row = env.participants.findByPlatformUser("discord", "123");
    expect(row).not.toBeNull();
    expect(row!.platform).toBe("discord");
    expect(row!.platform_user_id).toBe("123");
    expect(row!.display_name).toBe("Taro");
  });

  it('同じ author で 2 回 inject → participants は重複せず 1 件のまま (display_name は最新値)', async () => {
    await createSession("pinj2");
    await env.app.request("/v1/sessions/pinj2/inject", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "first", source: "discord:456", author_label: "OldName" }),
    });
    await env.app.request("/v1/sessions/pinj2/inject", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "second", source: "discord:456", author_label: "NewName" }),
    });
    const rows = env.participants.listByCanonical("newname");
    // upsert で canonical_name も更新されるため "newname" で 1 件のみヒット
    expect(rows).toHaveLength(1);
    expect(rows[0].display_name).toBe("NewName");
  });

  it('source="test" (コロン区切りでない) → participants は増えない', async () => {
    await createSession("pinj3");
    await env.app.request("/v1/sessions/pinj3/inject", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "ctrl", source: "test", author_label: "Bot" }),
    });
    // participants テーブルは空のまま
    const row = env.participants.findByPlatformUser("test" as any, "");
    expect(row).toBeNull();
    // listByCanonical("bot") も空
    const rows = env.participants.listByCanonical("bot");
    expect(rows).toHaveLength(0);
  });
});
