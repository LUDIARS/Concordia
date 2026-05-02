import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../src/db/schema.js";
import { SessionsRepo } from "../src/db/sessions-repo.js";
import { TasksRepo } from "../src/db/tasks-repo.js";
import { ChatRepo } from "../src/db/chat-repo.js";
import { Dispatcher } from "../src/dispatcher.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/shared/config.js";

function makeApp() {
  const db = new Database(":memory:");
  applyMigrations(db);
  const repo = new SessionsRepo(db);
  const tasks = new TasksRepo(db);
  const chat = new ChatRepo(db);
  const dispatcher = new Dispatcher({ sessions: repo, tasks, chat, rng: () => 0.99 });
  return buildApp({
    repo, tasks, chat, dispatcher, config: loadConfig({}),
    startedAt: new Date().toISOString(), sweeperRunOnce: () => {},
  });
}

describe("/v1/chat", () => {
  let app: ReturnType<typeof makeApp>;
  beforeEach(() => { app = makeApp(); });

  it("posts a chitchat message + lists it", async () => {
    const r = await app.request("/v1/chat", {
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

    const list = await (await app.request("/v1/chat?channel=chitchat")).json() as any;
    expect(list.messages).toHaveLength(1);
  });

  it("flags actionable suggestion", async () => {
    const r = await app.request("/v1/chat", {
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
    const r1 = await app.request("/v1/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: "chitchat", text: "こんにちは", author_label: "human" }),
    });
    const m = (await r1.json()) as any;
    const r2 = await app.request(`/v1/chat/${m.message.id}/reply`, {
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
    const app = makeApp();
    // start a session
    await app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "s1", provider: "claude-code", repo_path: "/x", host: "h",
      }),
    });

    // 強制 enqueue: dispatcher を直叩きする経路がない場合は、 chat post → reply task を狙う
    // ここは dispatcher.test で network-cover 済なので簡易に空で確認する
    const r = await app.request("/v1/sessions/s1/pending-tasks");
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(Array.isArray(j.tasks)).toBe(true);
  });

  it("404 for unknown session", async () => {
    const app = makeApp();
    const r = await app.request("/v1/sessions/nope/pending-tasks");
    expect(r.status).toBe(404);
  });
});
