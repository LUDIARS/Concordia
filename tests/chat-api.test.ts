import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, type TestAppEnv } from "./helpers/test-app.js";

function makeEnv() {
  return makeTestApp({ rng: () => 0.99 });
}

describe("/v1/chat", () => {
  let env: TestAppEnv;
  beforeEach(() => { env = makeEnv(); });

  it("posts a chitchat message + lists it", async () => {
    const r = await env.app.request("/v1/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channel: "chitchat",
        text: "ふつうに流れてる",
        author_label: "human",
      }),
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.message.id).toBeGreaterThan(0);
    expect(j.message.is_actionable).toBe(false);

    const list = await (await env.app.request("/v1/chat?channel=chitchat")).json() as any;
    expect(list.messages).toHaveLength(1);
  });

  it("flags actionable suggestion", async () => {
    const r = await env.app.request("/v1/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channel: "consultation",
        text: "ここを refactor した方がいい",
        author_label: "リファクタ職人",
      }),
    });
    const j = (await r.json()) as any;
    expect(j.message.is_actionable).toBe(true);
  });

  it("reply attaches in_reply_to", async () => {
    const r1 = await env.app.request("/v1/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: "chitchat", text: "こんにちは", author_label: "human" }),
    });
    const m = (await r1.json()) as any;
    const r2 = await env.app.request(`/v1/chat/${m.message.id}/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: "chitchat", text: "や", author_label: "テスト魂" }),
    });
    const j2 = (await r2.json()) as any;
    expect(j2.message.in_reply_to).toBe(m.message.id);
  });
});

describe("/v1/sessions/:id/pending-tasks", () => {
  it("pulls tasks once", async () => {
    const env = makeEnv();
    // session を DB に直接登録 (API 経由でも等価)
    await env.app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "s1", provider: "claude-code", repo_path: "/x", host: "h",
      }),
    });

    // tasks.enqueue で対象 session 宛に 1 件 enqueue
    env.tasks.enqueue({ session_id: "s1", kind: "stat-collect", payload: {} });

    // 1 回目: task が 1 件返る
    const r1 = await env.app.request("/v1/sessions/s1/pending-tasks");
    expect(r1.status).toBe(200);
    const j1 = (await r1.json()) as any;
    expect(Array.isArray(j1.tasks)).toBe(true);
    expect(j1.tasks).toHaveLength(1);

    // 2 回目: delivered 済みなので空 (= once)
    const r2 = await env.app.request("/v1/sessions/s1/pending-tasks");
    expect(r2.status).toBe(200);
    const j2 = (await r2.json()) as any;
    expect(j2.tasks).toHaveLength(0);
  });

  it("404 for unknown session", async () => {
    const env = makeEnv();
    const r = await env.app.request("/v1/sessions/nope/pending-tasks");
    expect(r.status).toBe(404);
  });
});
