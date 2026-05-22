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

/** 深夜帯抑制を受けないよう昼帯に固定 (14:00 local). */
const DAYTIME = () => new Date(2026, 4, 22, 14, 0, 0);
/** 深夜帯 (23:00–翌05:00) テスト用 (02:00 local). */
const NIGHT = () => new Date(2026, 4, 22, 2, 0, 0);

describe("Dispatcher (smarter triggers)", () => {
  let env: ReturnType<typeof fresh>;
  beforeEach(() => { env = fresh(); });

  it("review-summary fires when work-event count is multiple of 5", () => {
    startSession(env.sessions, "a");
    const d = new Dispatcher({ ...env, rng: () => 0.99, now: DAYTIME });
    for (let i = 0; i < 5; i++) {
      env.sessions.appendEvent({
        session_id: "a", ts: i, kind: "edit",
        payload: { file: "src/foo.ts" },
      });
    }
    const session = env.sessions.findSession("a")!;
    d.onEventAppended(session, 5);
    const pulled = env.tasks.pull("a");
    expect(pulled.find((t) => t.kind === "review-summary")).toBeTruthy();
  });

  it("topic-shift triggers chitchat-suggest with new-area kind", () => {
    startSession(env.sessions, "b");
    for (let i = 0; i < 4; i++) {
      env.sessions.appendEvent({
        session_id: "b", ts: i, kind: "edit",
        payload: { file: "src/api/foo.ts" },
      });
    }
    env.sessions.appendEvent({
      session_id: "b", ts: 100, kind: "edit",
      payload: { file: "tests/foo.test.ts" },
    });
    const d = new Dispatcher({ ...env, rng: () => 0.5, now: DAYTIME });
    const session = env.sessions.findSession("b")!;
    d.onEventAppended(session, 5);
    const pulled = env.tasks.pull("b");
    const t = pulled.find((x) => x.kind === "chitchat-suggest");
    expect(t).toBeTruthy();
    const payload = JSON.parse(t!.payload);
    expect(payload.chitchat_kind).toBe("new-area");
    expect(typeof payload.seed).toBe("string");
  });

  it("random pure chitchat fires below probability threshold", () => {
    startSession(env.sessions, "c");
    env.sessions.appendEvent({ session_id: "c", ts: 1, kind: "prompt", payload: { summary: "hi" } });
    const d = new Dispatcher({ ...env, rng: () => 0.01, now: DAYTIME });
    const session = env.sessions.findSession("c")!;
    d.onEventAppended(session, 1);
    const pulled = env.tasks.pull("c");
    const t = pulled.find((x) => x.kind === "chitchat-suggest");
    expect(t).toBeTruthy();
    const payload = JSON.parse(t!.payload);
    expect(payload.chitchat_kind).toBe("pure");
  });

  it("onChatPosted enqueues chat-reply for other active sessions", () => {
    startSession(env.sessions, "a");
    startSession(env.sessions, "b");
    startSession(env.sessions, "c");
    const d = new Dispatcher({ ...env, rng: () => 0.05, now: DAYTIME });
    d.onChatPosted({
      id: 1, channel: "chitchat", session_id: "a",
      text: "今日は調子よい", author_label: "テスト魂", is_actionable: false,
    });
    expect(env.tasks.pull("b").find((t) => t.kind === "chat-reply")).toBeTruthy();
    expect(env.tasks.pull("c").find((t) => t.kind === "chat-reply")).toBeTruthy();
    expect(env.tasks.pull("a").length).toBe(0);
  });

  it("actionable suggestion sets is_actionable_suggestion in payload", () => {
    startSession(env.sessions, "a");
    startSession(env.sessions, "b");
    const d = new Dispatcher({ ...env, rng: () => 0.05, now: DAYTIME });
    d.onChatPosted({
      id: 2, channel: "consultation", session_id: "a",
      text: "もう少しテストを増やした方がいい",
      author_label: "テスト魂", is_actionable: true,
    });
    const t = env.tasks.pull("b").find((x) => x.kind === "chat-reply");
    const payload = JSON.parse(t!.payload);
    expect(payload.is_actionable_suggestion).toBe(true);
    expect(payload.instructions).toMatch(/ユーザに/);
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

  it("onLogUpdate enqueues peer-log-react to exactly one peer (round-robin, excludes source)", () => {
    startSession(env.sessions, "src");
    startSession(env.sessions, "p1");
    startSession(env.sessions, "p2");
    startSession(env.sessions, "p3");
    const d = new Dispatcher({ ...env, rng: () => 0.5 });

    // 1 回目: ref="r1" → p1 (cursor 0)
    d.onLogUpdate({ kind: "rule.add", ref: "r1", source_session_id: "src", summary: "added r1" });
    // 2 回目 (別 ref で cooldown 回避): → p2
    d.onLogUpdate({ kind: "rule.add", ref: "r2", source_session_id: "src", summary: "added r2" });
    // 3 回目 (別 ref): → p3
    d.onLogUpdate({ kind: "rule.add", ref: "r3", source_session_id: "src", summary: "added r3" });

    const collect = (id: string) => env.tasks.pull(id).filter((t) => t.kind === "peer-log-react").length;
    const total = collect("p1") + collect("p2") + collect("p3");
    // src は除外されてるので 0
    expect(env.tasks.pull("src").filter((t) => t.kind === "peer-log-react").length).toBe(0);
    // 3 件の event がそれぞれ 1 peer に届く (= 排他)
    expect(total).toBe(3);
  });

  it("onLogUpdate is rate-limited within cooldown for same key", () => {
    startSession(env.sessions, "p1");
    startSession(env.sessions, "p2");
    const d = new Dispatcher({ ...env, rng: () => 0.5 });

    d.onLogUpdate({ kind: "rule.fire", ref: "same-rule", summary: "fired" });
    // 同 key で即連発 → cooldown でスキップされる
    d.onLogUpdate({ kind: "rule.fire", ref: "same-rule", summary: "fired again" });

    const total =
      env.tasks.pull("p1").filter((t) => t.kind === "peer-log-react").length +
      env.tasks.pull("p2").filter((t) => t.kind === "peer-log-react").length;
    expect(total).toBe(1);
  });

  it("onLogUpdate does nothing when no peers are active", () => {
    startSession(env.sessions, "src");
    const d = new Dispatcher({ ...env, rng: () => 0.5 });
    d.onLogUpdate({ kind: "session.started", source_session_id: "src", ref: "src", summary: "alone" });
    expect(env.tasks.pull("src").length).toBe(0);
  });
});

describe("Dispatcher 強制ルール — 深夜帯 (23:00–翌05:00) は行動頻度 1/10", () => {
  let env: ReturnType<typeof fresh>;
  beforeEach(() => { env = fresh(); });

  it("深夜帯は work-count 軽レビューを 1/10 に間引く (rng 0.5 では発火しない)", () => {
    startSession(env.sessions, "a");
    // freq=0.1 のとき review gate は rng() < 0.1. rng=0.5 は閾値超えで skip.
    const d = new Dispatcher({ ...env, rng: () => 0.5, now: NIGHT });
    for (let i = 0; i < 5; i++) {
      env.sessions.appendEvent({
        session_id: "a", ts: i, kind: "edit",
        payload: { file: "src/foo.ts" },
      });
    }
    d.onEventAppended(env.sessions.findSession("a")!, 5);
    expect(env.tasks.pull("a").find((t) => t.kind === "review-summary")).toBeFalsy();
  });

  it("深夜帯でも rng が 1/10 閾値を下回れば軽レビューは発火する", () => {
    startSession(env.sessions, "a");
    // rng=0.05 < freq=0.1 → 間引きを通過して発火.
    const d = new Dispatcher({ ...env, rng: () => 0.05, now: NIGHT });
    for (let i = 0; i < 5; i++) {
      env.sessions.appendEvent({
        session_id: "a", ts: i, kind: "edit",
        payload: { file: "src/foo.ts" },
      });
    }
    d.onEventAppended(env.sessions.findSession("a")!, 5);
    expect(env.tasks.pull("a").find((t) => t.kind === "review-summary")).toBeTruthy();
  });

  it("深夜帯は topic-shift 雑談確率を 0.7→0.07 に下げる (rng 0.5 では発火しない)", () => {
    startSession(env.sessions, "b");
    for (let i = 0; i < 4; i++) {
      env.sessions.appendEvent({
        session_id: "b", ts: i, kind: "edit",
        payload: { file: "src/api/foo.ts" },
      });
    }
    env.sessions.appendEvent({
      session_id: "b", ts: 100, kind: "edit",
      payload: { file: "tests/foo.test.ts" },
    });
    // 昼帯なら rng=0.5 < 0.7 で発火するが、 深夜帯は閾値 0.07 で skip.
    const d = new Dispatcher({ ...env, rng: () => 0.5, now: NIGHT });
    d.onEventAppended(env.sessions.findSession("b")!, 5);
    expect(env.tasks.pull("b").find((t) => t.kind === "chitchat-suggest")).toBeFalsy();
  });

  it("深夜帯は chat-reply 確率を 1/10 に下げる (chitchat 0.3→0.03, rng 0.05 では発火しない)", () => {
    startSession(env.sessions, "a");
    startSession(env.sessions, "b");
    // 昼帯なら rng=0.05 < 0.3 で reply するが、 深夜帯は閾値 0.03 で skip.
    const d = new Dispatcher({ ...env, rng: () => 0.05, now: NIGHT });
    d.onChatPosted({
      id: 1, channel: "chitchat", session_id: "a",
      text: "夜更かし中", author_label: "テスト魂", is_actionable: false,
    });
    expect(env.tasks.pull("b").find((t) => t.kind === "chat-reply")).toBeFalsy();
  });

  it("session-departed 通知は深夜帯でも間引かれない (ライフサイクル通知は対象外)", () => {
    startSession(env.sessions, "lost-one");
    startSession(env.sessions, "active-one");
    env.sessions.setStatus("lost-one", "lost", 100);
    const d = new Dispatcher({ ...env, rng: () => 0.99, now: NIGHT });
    d.onSessionLost(env.sessions.findSession("lost-one")!);
    expect(env.tasks.pull("active-one").find((t) => t.kind === "session-departed")).toBeTruthy();
  });
});
