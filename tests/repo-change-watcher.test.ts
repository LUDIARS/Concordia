import { describe, it, expect, beforeEach } from "vitest";
import { makeTestDb } from "./helpers/db.js";
import { SessionsRepo } from "../src/db/sessions-repo.js";
import { TasksRepo } from "../src/db/tasks-repo.js";
import { startRepoChangeWatcher } from "../src/stat/repo-change-watcher.js";
import { eventBus, type ConcordiaEvent } from "../src/events.js";

function fresh() {
  const db = makeTestDb();
  return {
    db,
    sessions: new SessionsRepo(db),
    tasks: new TasksRepo(db),
  };
}

function startSession(repo: SessionsRepo, id: string, repoPath: string) {
  repo.insertSession({
    id,
    provider: "claude-code",
    repo_path: repoPath,
    repo_origin: null,
    branch: "main",
    host: "h",
    started_at: 1000,
    last_seen_at: 1000,
    transcript_path: null,
    metadata: null,
  });
}

describe("startRepoChangeWatcher (title-watcher)", () => {
  let env: ReturnType<typeof fresh>;
  beforeEach(() => { env = fresh(); });

  it("初回・repo変更・prompt・再監視で自動タイトルタスクを投げない", () => {
    startSession(env.sessions, "s1", "/repo/A");
    const before = env.tasks.enqueue({ session_id: "s1", kind: "chat-reply", payload: { text: "keep" } });
    let w = startRepoChangeWatcher({ sessions: env.sessions });
    try {
      w.handle({ type: "stat.collected", session_id: "s1", stat_id: 1, ts: 1000 });
      expect(w.peekCache().lastRepoPath.get("s1")).toBe("/repo/A");
      env.sessions.patchSession("s1", { repo_path: "/repo/B" });
      w.handle({ type: "stat.collected", session_id: "s1", stat_id: 2, ts: 1100 });
      w.handle({ type: "session.event", session_id: "s1", kind: "prompt", ts: 1200 });
      w.handle({ type: "session.event", session_id: "s1", kind: "prompt", ts: 1201 });
      w.stop();
      w = startRepoChangeWatcher({ sessions: env.sessions });
      w.handle({ type: "stat.collected", session_id: "s1", stat_id: 3, ts: 1300 });
      const pending = env.tasks.pull("s1");
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({ id: before.id, kind: "chat-reply" });
      expect(JSON.parse(pending[0].payload)).toEqual({ text: "keep" });
      expect(env.tasks.pull("s1")).toHaveLength(0);
    } finally { w.stop(); }
  });

  it("session が存在しない stat.collected は無視", () => {
    const w = startRepoChangeWatcher({ sessions: env.sessions });
    try {
      w.handle({ type: "stat.collected", session_id: "ghost", stat_id: 1, ts: 1000 });
      expect(w.peekCache().lastRepoPath.has("ghost")).toBe(false);
    } finally { w.stop(); }
  });

  it("関係ない event は素通し", () => {
    startSession(env.sessions, "s1", "/repo/A");
    const w = startRepoChangeWatcher({ sessions: env.sessions });
    try {
      w.handle({ type: "ping", ts: 1000 });
      expect(w.peekCache().lastRepoPath.size).toBe(0);
    } finally { w.stop(); }
  });

  it("current_task が変わると title_renamed を emit して channel rename する (案C / AI 非依存)", () => {
    startSession(env.sessions, "s1", "/repo/A");
    env.sessions.patchSession("s1", { current_task: "Quaestor のレシート検知" });
    const seen: ConcordiaEvent[] = [];
    const unsub = eventBus.subscribe((ev) => {
      if (ev.type === "session.event" && ev.kind === "title_renamed" && ev.session_id === "s1") seen.push(ev);
    });
    const w = startRepoChangeWatcher({ sessions: env.sessions });
    try {
      w.handle({ type: "stat.collected", session_id: "s1", stat_id: 1, ts: 1000 });
      expect(seen).toHaveLength(1);
      const latest = env.sessions.recentEvents("s1", 1)[0];
      expect(latest.kind).toBe("title_renamed");
      expect(JSON.parse(latest.payload).text).toBe("Quaestor のレシート検知");
    } finally { w.stop(); unsub(); }
  });

  it("current_task が同じなら 2 回目以降は rename しない (dedup)", () => {
    startSession(env.sessions, "s1", "/repo/A");
    env.sessions.patchSession("s1", { current_task: "同じ作業" });
    const seen: ConcordiaEvent[] = [];
    const unsub = eventBus.subscribe((ev) => {
      if (ev.type === "session.event" && ev.kind === "title_renamed" && ev.session_id === "s1") seen.push(ev);
    });
    const w = startRepoChangeWatcher({ sessions: env.sessions });
    try {
      w.handle({ type: "stat.collected", session_id: "s1", stat_id: 1, ts: 1000 });
      w.handle({ type: "stat.collected", session_id: "s1", stat_id: 2, ts: 1100 });
      expect(seen).toHaveLength(1);
    } finally { w.stop(); unsub(); }
  });
});
