import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../src/db/schema.js";
import { SessionsRepo } from "../src/db/sessions-repo.js";
import { TasksRepo } from "../src/db/tasks-repo.js";
import { startRepoChangeWatcher } from "../src/stat/repo-change-watcher.js";

function fresh() {
  const db = new Database(":memory:");
  applyMigrations(db);
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

describe("startRepoChangeWatcher", () => {
  let env: ReturnType<typeof fresh>;
  beforeEach(() => { env = fresh(); });

  it("初回 stat は cache に記録するだけで title-suggest を enqueue しない", () => {
    startSession(env.sessions, "s1", "/repo/A");
    const w = startRepoChangeWatcher({ sessions: env.sessions, tasks: env.tasks });
    try {
      w.handle({ type: "stat.collected", session_id: "s1", stat_id: 1, ts: 1000 });
      const pending = env.tasks.pull("s1");
      expect(pending).toHaveLength(0);
      expect(w.peekCache().get("s1")).toBe("/repo/A");
    } finally { w.stop(); }
  });

  it("repo_path 変化で title-suggest を 1 件 enqueue する", () => {
    startSession(env.sessions, "s1", "/repo/A");
    const w = startRepoChangeWatcher({ sessions: env.sessions, tasks: env.tasks });
    try {
      // 1 回目: cache 記録
      w.handle({ type: "stat.collected", session_id: "s1", stat_id: 1, ts: 1000 });
      // repo を変更
      env.sessions.patchSession("s1", { repo_path: "/repo/B" });
      // 2 回目: 変化検出 → enqueue
      w.handle({ type: "stat.collected", session_id: "s1", stat_id: 2, ts: 1100 });

      const pending = env.tasks.pull("s1");
      expect(pending).toHaveLength(1);
      expect(pending[0].kind).toBe("title-suggest");
      const payload = JSON.parse(pending[0].payload);
      expect(payload.previous_repo_path).toBe("/repo/A");
      expect(payload.current_repo_path).toBe("/repo/B");
      expect(typeof payload.instructions).toBe("string");
      expect(payload.instructions).toContain("30 文字以内");
    } finally { w.stop(); }
  });

  it("repo_path 同じなら enqueue しない", () => {
    startSession(env.sessions, "s1", "/repo/A");
    const w = startRepoChangeWatcher({ sessions: env.sessions, tasks: env.tasks });
    try {
      w.handle({ type: "stat.collected", session_id: "s1", stat_id: 1, ts: 1000 });
      w.handle({ type: "stat.collected", session_id: "s1", stat_id: 2, ts: 1100 });
      w.handle({ type: "stat.collected", session_id: "s1", stat_id: 3, ts: 1200 });
      expect(env.tasks.pull("s1")).toHaveLength(0);
    } finally { w.stop(); }
  });

  it("title-suggest が未配信なら同 session に二重 enqueue しない", () => {
    startSession(env.sessions, "s1", "/repo/A");
    const w = startRepoChangeWatcher({ sessions: env.sessions, tasks: env.tasks });
    try {
      w.handle({ type: "stat.collected", session_id: "s1", stat_id: 1, ts: 1000 });
      env.sessions.patchSession("s1", { repo_path: "/repo/B" });
      w.handle({ type: "stat.collected", session_id: "s1", stat_id: 2, ts: 1100 });
      // 1 件 enqueue 済
      // さらに repo 変更しても未配信 task が残ってるので追加しない
      env.sessions.patchSession("s1", { repo_path: "/repo/C" });
      w.handle({ type: "stat.collected", session_id: "s1", stat_id: 3, ts: 1200 });

      const all = env.tasks.pull("s1");
      expect(all).toHaveLength(1);
    } finally { w.stop(); }
  });

  it("session が存在しない event は無視", () => {
    const w = startRepoChangeWatcher({ sessions: env.sessions, tasks: env.tasks });
    try {
      w.handle({ type: "stat.collected", session_id: "ghost", stat_id: 1, ts: 1000 });
      expect(w.peekCache().has("ghost")).toBe(false);
    } finally { w.stop(); }
  });

  it("stat.collected 以外の event は素通し", () => {
    startSession(env.sessions, "s1", "/repo/A");
    const w = startRepoChangeWatcher({ sessions: env.sessions, tasks: env.tasks });
    try {
      w.handle({ type: "ping", ts: 1000 });
      expect(w.peekCache().size).toBe(0);
    } finally { w.stop(); }
  });
});
