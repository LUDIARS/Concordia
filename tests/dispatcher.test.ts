import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../src/db/schema.js";
import { SessionsRepo } from "../src/db/sessions-repo.js";
import { TasksRepo } from "../src/db/tasks-repo.js";
import { ChatRepo } from "../src/db/chat-repo.js";
import { Dispatcher } from "../src/dispatcher.js";

function fresh() {
  const db = new Database(":memory:");
  applyMigrations(db);
  const sessions = new SessionsRepo(db);
  const tasks = new TasksRepo(db);
  const chat = new ChatRepo(db);
  return { db, sessions, tasks, chat };
}

function startSession(repo: SessionsRepo, id: string, branch = "main") {
  repo.insertSession({
    id, provider: "claude-code", repo_path: "/x",
    repo_origin: "origin", branch, host: "h",
    started_at: 1, last_seen_at: 1, transcript_path: null, metadata: null,
  });
}

describe("Dispatcher", () => {
  let env: ReturnType<typeof fresh>;
  beforeEach(() => { env = fresh(); });

  it("review-summary fires every 10 events", () => {
    startSession(env.sessions, "a");
    const d = new Dispatcher({ ...env, rng: () => 0.99 }); // chitchat は確率 fail
    for (let i = 0; i < 10; i++) {
      env.sessions.appendEvent({ session_id: "a", ts: i, kind: "prompt", payload: { x: i } });
    }
    const session = env.sessions.findSession("a")!;
    d.onEventAppended(session, 10);
    const pulled = env.tasks.pull("a");
    expect(pulled.find((t) => t.kind === "review-summary")).toBeTruthy();
  });

  it("chitchat-suggest fires under probability threshold", () => {
    startSession(env.sessions, "b");
    const d = new Dispatcher({ ...env, rng: () => 0.05 }); // 確率 hit
    const session = env.sessions.findSession("b")!;
    d.onEventAppended(session, 1);
    const pulled = env.tasks.pull("b");
    expect(pulled.find((t) => t.kind === "chitchat-suggest")).toBeTruthy();
  });

  it("onChatPosted enqueues chat-reply for other active sessions", () => {
    startSession(env.sessions, "a");
    startSession(env.sessions, "b");
    startSession(env.sessions, "c");
    const d = new Dispatcher({ ...env, rng: () => 0.05 }); // 全 reply 発火
    d.onChatPosted({
      id: 1, channel: "chitchat", session_id: "a",
      text: "今日は調子よい", author_label: "テスト魂", is_actionable: false,
    });
    expect(env.tasks.pull("b").find((t) => t.kind === "chat-reply")).toBeTruthy();
    expect(env.tasks.pull("c").find((t) => t.kind === "chat-reply")).toBeTruthy();
    expect(env.tasks.pull("a").length).toBe(0); // 自分には送らない
  });

  it("actionable suggestion sets is_actionable_suggestion in payload", () => {
    startSession(env.sessions, "a");
    startSession(env.sessions, "b");
    const d = new Dispatcher({ ...env, rng: () => 0.05 });
    d.onChatPosted({
      id: 2, channel: "consultation", session_id: "a",
      text: "もう少しテストを増やした方がいい",
      author_label: "テスト魂", is_actionable: true,
    });
    const t = env.tasks.pull("b").find((x) => x.kind === "chat-reply");
    const payload = JSON.parse(t!.payload);
    expect(payload.is_actionable_suggestion).toBe(true);
    expect(payload.instructions).toMatch(/ユーザに確認/);
  });

  it("onSessionLost notifies all other active sessions", () => {
    startSession(env.sessions, "lost-one");
    startSession(env.sessions, "active-one");
    startSession(env.sessions, "active-two");
    env.sessions.setStatus("lost-one", "lost", 100);
    const d = new Dispatcher({ ...env, rng: () => 0.99 });
    const lost = env.sessions.findSession("lost-one")!;
    d.onSessionLost(lost);
    expect(env.tasks.pull("active-one").find((t) => t.kind === "session-departed")).toBeTruthy();
    expect(env.tasks.pull("active-two").find((t) => t.kind === "session-departed")).toBeTruthy();
  });

  it("onSessionEnd enqueues daily-report to self", () => {
    startSession(env.sessions, "a");
    const d = new Dispatcher({ ...env, rng: () => 0.99 });
    const session = env.sessions.findSession("a")!;
    d.onSessionEnd(session, { duration_sec: 100 });
    const pulled = env.tasks.pull("a");
    expect(pulled.find((t) => t.kind === "daily-report")).toBeTruthy();
  });
});
