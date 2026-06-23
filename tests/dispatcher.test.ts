import { describe, it, expect, beforeEach } from "vitest";
import { makeTestDb } from "./helpers/db.js";
import { SessionsRepo } from "../src/db/sessions-repo.js";
import { TasksRepo } from "../src/db/tasks-repo.js";
import { ChatRepo } from "../src/db/chat-repo.js";
import { Dispatcher } from "../src/dispatcher.js";
import type { ChatResponder, SpeakRequest } from "../src/chat/responder.js";

/**
 * セッション帰属の発話 (雑談 / 軽レビュー / peer 返信 / ログ反応) は、 その
 * セッションのタスクキューに積まれ **セッション側 LLM** が書く (記憶反映).
 * Concordia 自身の声 (離脱告知) だけ中央 Haiku レスポンダが描画する.
 *
 * fake responder で「司会の発話」 呼び出しを同期記録して検証する.
 */
function fakeResponder() {
  const calls: SpeakRequest[] = [];
  const responder = {
    speak: async (req: SpeakRequest) => { calls.push(req); },
    attachFanout: () => {},
    voiceForSession: () => ({ name: "x", display_name: "x" }),
  } as unknown as ChatResponder;
  return { responder, calls };
}

function fresh() {
  const db = makeTestDb();
  const sessions = new SessionsRepo(db);
  const tasks = new TasksRepo(db);
  const chat = new ChatRepo(db);
  const { responder, calls } = fakeResponder();
  return { db, sessions, tasks, chat, responder, calls };
}

function startSession(repo: SessionsRepo, id: string, branch = "main") {
  repo.insertSession({
    id, provider: "claude-code", repo_path: "/x",
    repo_origin: "origin", branch, host: "h",
    started_at: 1, last_seen_at: 1, transcript_path: null, metadata: null,
  });
}

/** 深夜帯抑制を受けないよう昼帯に固定 (14:00 local). */
const DAYTIME = () => new Date(2026, 4, 22, 14, 0, 0);
/** 深夜帯 (23:00–翌05:00) テスト用 (02:00 local). */
const NIGHT = () => new Date(2026, 4, 22, 2, 0, 0);

function mkDispatcher(env: ReturnType<typeof fresh>, rng: () => number, now = DAYTIME) {
  return new Dispatcher({ sessions: env.sessions, tasks: env.tasks, chat: env.chat, responder: env.responder, rng, now });
}

describe("Dispatcher — セッション帰属は task 注入 (session LLM)", () => {
  let env: ReturnType<typeof fresh>;
  beforeEach(() => { env = fresh(); });

  it("review-summary task fires when work-event count is multiple of 5", () => {
    startSession(env.sessions, "a");
    const d = mkDispatcher(env, () => 0.99);
    for (let i = 0; i < 5; i++) {
      env.sessions.appendEvent({ session_id: "a", ts: i, kind: "edit", payload: { file: "src/foo.ts" } });
    }
    d.onEventAppended(env.sessions.findSession("a")!, 5);
    expect(env.tasks.pull("a").find((t) => t.kind === "review-summary")).toBeTruthy();
  });

  it("topic-shift enqueues chitchat-suggest with new-area kind", () => {
    startSession(env.sessions, "b");
    for (let i = 0; i < 4; i++) {
      env.sessions.appendEvent({ session_id: "b", ts: i, kind: "edit", payload: { file: "src/api/foo.ts" } });
    }
    env.sessions.appendEvent({ session_id: "b", ts: 100, kind: "edit", payload: { file: "tests/foo.test.ts" } });
    const d = mkDispatcher(env, () => 0.5);
    d.onEventAppended(env.sessions.findSession("b")!, 5);
    const t = env.tasks.pull("b").find((x) => x.kind === "chitchat-suggest");
    expect(t).toBeTruthy();
    const payload = JSON.parse(t!.payload);
    expect(payload.chitchat_kind).toBe("new-area");
    expect(typeof payload.seed).toBe("string");
  });

  it("random pure chitchat fires below probability threshold", () => {
    startSession(env.sessions, "c");
    env.sessions.appendEvent({ session_id: "c", ts: 1, kind: "prompt", payload: { summary: "hi" } });
    const d = mkDispatcher(env, () => 0.01);
    d.onEventAppended(env.sessions.findSession("c")!, 1);
    const t = env.tasks.pull("c").find((x) => x.kind === "chitchat-suggest");
    expect(t).toBeTruthy();
    expect(JSON.parse(t!.payload).chitchat_kind).toBe("pure");
  });

  it("onChatPosted enqueues chat-reply to other active sessions (session LLM), excludes source", () => {
    startSession(env.sessions, "a");
    startSession(env.sessions, "b");
    startSession(env.sessions, "c");
    const d = mkDispatcher(env, () => 0.05);
    d.onChatPosted({ id: 1, channel: "chitchat", session_id: "a", text: "今日は調子よい", author_label: "テスト魂", is_actionable: false });
    expect(env.tasks.pull("b").find((t) => t.kind === "chat-reply")).toBeTruthy();
    expect(env.tasks.pull("c").find((t) => t.kind === "chat-reply")).toBeTruthy();
    expect(env.tasks.pull("a").length).toBe(0);
  });

  it("actionable suggestion sets is_actionable_suggestion in the chat-reply payload", () => {
    startSession(env.sessions, "a");
    startSession(env.sessions, "b");
    const d = mkDispatcher(env, () => 0.05);
    d.onChatPosted({ id: 2, channel: "consultation", session_id: "a", text: "もう少しテストを増やした方がいい", author_label: "テスト魂", is_actionable: true });
    const t = env.tasks.pull("b").find((x) => x.kind === "chat-reply");
    const payload = JSON.parse(t!.payload);
    expect(payload.is_actionable_suggestion).toBe(true);
    expect(payload.instructions).toMatch(/ユーザに/);
  });

  it("reply chain stops at MAX_REPLY_DEPTH (coordinator-initiated)", () => {
    startSession(env.sessions, "a");
    startSession(env.sessions, "b");
    const d = mkDispatcher(env, () => 0.05);
    d.onChatPosted({ id: 9, channel: "chitchat", session_id: "a", text: "x", author_label: "t", is_actionable: false }, 2);
    expect(env.tasks.pull("b").length).toBe(0);
  });

  it("onLogUpdate enqueues peer-log-react to exactly one peer (round-robin, excludes source)", () => {
    startSession(env.sessions, "src");
    startSession(env.sessions, "p1");
    startSession(env.sessions, "p2");
    startSession(env.sessions, "p3");
    const d = mkDispatcher(env, () => 0.5);
    d.onLogUpdate({ kind: "rule.add", ref: "r1", source_session_id: "src", summary: "added r1" });
    d.onLogUpdate({ kind: "rule.add", ref: "r2", source_session_id: "src", summary: "added r2" });
    d.onLogUpdate({ kind: "rule.add", ref: "r3", source_session_id: "src", summary: "added r3" });
    const collect = (id: string) => env.tasks.pull(id).filter((t) => t.kind === "peer-log-react").length;
    expect(env.tasks.pull("src").filter((t) => t.kind === "peer-log-react").length).toBe(0);
    expect(collect("p1")).toBe(1);
    expect(collect("p2")).toBe(1);
    expect(collect("p3")).toBe(1);
  });

  it("onLogUpdate is rate-limited within cooldown for same key", () => {
    startSession(env.sessions, "p1");
    startSession(env.sessions, "p2");
    const d = mkDispatcher(env, () => 0.5);
    d.onLogUpdate({ kind: "rule.fire", ref: "same-rule", summary: "fired" });
    d.onLogUpdate({ kind: "rule.fire", ref: "same-rule", summary: "fired again" });
    const total =
      env.tasks.pull("p1").filter((t) => t.kind === "peer-log-react").length +
      env.tasks.pull("p2").filter((t) => t.kind === "peer-log-react").length;
    expect(total).toBe(1);
  });

  it("onLogUpdate does nothing when no peers are active", () => {
    startSession(env.sessions, "src");
    const d = mkDispatcher(env, () => 0.5);
    d.onLogUpdate({ kind: "session.started", source_session_id: "src", ref: "src", summary: "alone" });
    expect(env.tasks.pull("src").length).toBe(0);
  });
});

describe("Dispatcher — Concordia 自身の声は中央 Haiku", () => {
  let env: ReturnType<typeof fresh>;
  beforeEach(() => { env = fresh(); });

  it("onSessionLost posts a single coordinator notice (responder), not session-departed tasks", () => {
    startSession(env.sessions, "lost-one");
    startSession(env.sessions, "active-one");
    startSession(env.sessions, "active-two");
    env.sessions.setStatus("lost-one", "lost", 100);
    const d = mkDispatcher(env, () => 0.99);
    d.onSessionLost(env.sessions.findSession("lost-one")!);
    const notices = env.calls.filter((x) => x.intent === "notice");
    expect(notices.length).toBe(1);
    expect(notices[0].sessionId ?? null).toBe(null); // 司会
    expect(notices[0].context.extra).toMatch(/離脱/);
    // セッション task は積まれない
    expect(env.tasks.pull("active-one").length).toBe(0);
    expect(env.tasks.pull("active-two").length).toBe(0);
  });

  it("onSessionEnd is a no-op (report path owns the monologue)", () => {
    startSession(env.sessions, "a");
    const d = mkDispatcher(env, () => 0.99);
    d.onSessionEnd(env.sessions.findSession("a")!, { duration_sec: 100 });
    expect(env.calls.length).toBe(0);
    expect(env.tasks.pull("a").length).toBe(0);
  });
});

describe("Dispatcher 強制ルール — 深夜帯 (23:00–翌05:00) は行動頻度 1/10", () => {
  let env: ReturnType<typeof fresh>;
  beforeEach(() => { env = fresh(); });

  it("深夜帯は work-count 軽レビューを 1/10 に間引く (rng 0.5 では発火しない)", () => {
    startSession(env.sessions, "a");
    const d = mkDispatcher(env, () => 0.5, NIGHT);
    for (let i = 0; i < 5; i++) {
      env.sessions.appendEvent({ session_id: "a", ts: i, kind: "edit", payload: { file: "src/foo.ts" } });
    }
    d.onEventAppended(env.sessions.findSession("a")!, 5);
    expect(env.tasks.pull("a").find((t) => t.kind === "review-summary")).toBeFalsy();
  });

  it("深夜帯でも rng が 1/10 閾値を下回れば軽レビューは発火する", () => {
    startSession(env.sessions, "a");
    const d = mkDispatcher(env, () => 0.05, NIGHT);
    for (let i = 0; i < 5; i++) {
      env.sessions.appendEvent({ session_id: "a", ts: i, kind: "edit", payload: { file: "src/foo.ts" } });
    }
    d.onEventAppended(env.sessions.findSession("a")!, 5);
    expect(env.tasks.pull("a").find((t) => t.kind === "review-summary")).toBeTruthy();
  });

  it("深夜帯は topic-shift 雑談確率を 0.7→0.07 に下げる (rng 0.5 では発火しない)", () => {
    startSession(env.sessions, "b");
    for (let i = 0; i < 4; i++) {
      env.sessions.appendEvent({ session_id: "b", ts: i, kind: "edit", payload: { file: "src/api/foo.ts" } });
    }
    env.sessions.appendEvent({ session_id: "b", ts: 100, kind: "edit", payload: { file: "tests/foo.test.ts" } });
    const d = mkDispatcher(env, () => 0.5, NIGHT);
    d.onEventAppended(env.sessions.findSession("b")!, 5);
    expect(env.tasks.pull("b").find((t) => t.kind === "chitchat-suggest")).toBeFalsy();
  });

  it("深夜帯は chat-reply 確率を 1/10 に下げる (chitchat 0.3→0.03, rng 0.05 では発火しない)", () => {
    startSession(env.sessions, "a");
    startSession(env.sessions, "b");
    const d = mkDispatcher(env, () => 0.05, NIGHT);
    d.onChatPosted({ id: 1, channel: "chitchat", session_id: "a", text: "夜更かし中", author_label: "テスト魂", is_actionable: false });
    expect(env.tasks.pull("b").find((t) => t.kind === "chat-reply")).toBeFalsy();
  });

  it("session 離脱告知は深夜帯でも間引かれない (Concordia 自身の声)", () => {
    startSession(env.sessions, "lost-one");
    startSession(env.sessions, "active-one");
    env.sessions.setStatus("lost-one", "lost", 100);
    const d = mkDispatcher(env, () => 0.99, NIGHT);
    d.onSessionLost(env.sessions.findSession("lost-one")!);
    expect(env.calls.find((x) => x.intent === "notice")).toBeTruthy();
  });
});
