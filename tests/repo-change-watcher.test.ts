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

describe("startRepoChangeWatcher (title-watcher)", () => {
  let env: ReturnType<typeof fresh>;
  beforeEach(() => { env = fresh(); });

  it("初回 stat で title-suggest を 1 件 enqueue する (起動直後にもタイトルを設定するため)", () => {
    startSession(env.sessions, "s1", "/repo/A");
    const w = startRepoChangeWatcher({ sessions: env.sessions, tasks: env.tasks });
    try {
      w.handle({ type: "stat.collected", session_id: "s1", stat_id: 1, ts: 1000 });
      const pending = env.tasks.pull("s1");
      expect(pending).toHaveLength(1);
      expect(pending[0].kind).toBe("title-suggest");
      const payload = JSON.parse(pending[0].payload);
      expect(payload.reason).toBe("initial");
      expect(payload.current_repo_path).toBe("/repo/A");
      expect(w.peekCache().lastRepoPath.get("s1")).toBe("/repo/A");
    } finally { w.stop(); }
  });

  it("repo_path 変化で title-suggest を 1 件 enqueue する", () => {
    startSession(env.sessions, "s1", "/repo/A");
    const w = startRepoChangeWatcher({ sessions: env.sessions, tasks: env.tasks });
    try {
      // 1 回目: 初回 → enqueue & 受け取り消費
      w.handle({ type: "stat.collected", session_id: "s1", stat_id: 1, ts: 1000 });
      env.tasks.pull("s1");
      // repo を変更
      env.sessions.patchSession("s1", { repo_path: "/repo/B" });
      // 2 回目: 変化検出 → enqueue
      w.handle({ type: "stat.collected", session_id: "s1", stat_id: 2, ts: 1100 });

      const pending = env.tasks.pull("s1");
      expect(pending).toHaveLength(1);
      expect(pending[0].kind).toBe("title-suggest");
      const payload = JSON.parse(pending[0].payload);
      expect(payload.reason).toBe("repo_change");
      expect(payload.previous_repo_path).toBe("/repo/A");
      expect(payload.current_repo_path).toBe("/repo/B");
    } finally { w.stop(); }
  });

  it("repo_path 同じなら 2 回目以降は enqueue しない", () => {
    startSession(env.sessions, "s1", "/repo/A");
    const w = startRepoChangeWatcher({ sessions: env.sessions, tasks: env.tasks });
    try {
      w.handle({ type: "stat.collected", session_id: "s1", stat_id: 1, ts: 1000 });
      env.tasks.pull("s1"); // 初回 enqueue ぶんを消費
      w.handle({ type: "stat.collected", session_id: "s1", stat_id: 2, ts: 1100 });
      w.handle({ type: "stat.collected", session_id: "s1", stat_id: 3, ts: 1200 });
      expect(env.tasks.pull("s1")).toHaveLength(0);
    } finally { w.stop(); }
  });

  it("title-suggest が未配信なら同 session に二重 enqueue しない", () => {
    startSession(env.sessions, "s1", "/repo/A");
    const w = startRepoChangeWatcher({ sessions: env.sessions, tasks: env.tasks });
    try {
      // 初回 enqueue (未配信のまま)
      w.handle({ type: "stat.collected", session_id: "s1", stat_id: 1, ts: 1000 });
      // 別契機 (repo 変化) が来ても未配信が残っているので追加しない
      env.sessions.patchSession("s1", { repo_path: "/repo/B" });
      w.handle({ type: "stat.collected", session_id: "s1", stat_id: 2, ts: 1100 });
      const all = env.tasks.pull("s1");
      expect(all).toHaveLength(1);
    } finally { w.stop(); }
  });

  it("新 prompt event で title-suggest を enqueue する", () => {
    startSession(env.sessions, "s1", "/repo/A");
    const w = startRepoChangeWatcher({ sessions: env.sessions, tasks: env.tasks });
    try {
      w.handle({ type: "session.event", session_id: "s1", kind: "prompt", ts: 2000 });
      const pending = env.tasks.pull("s1");
      expect(pending).toHaveLength(1);
      expect(JSON.parse(pending[0].payload).reason).toBe("prompt");
    } finally { w.stop(); }
  });

  it("prompt event は 30 秒以内に再発火しない (debounce)", () => {
    startSession(env.sessions, "s1", "/repo/A");
    let t = 1_000_000;
    const w = startRepoChangeWatcher({
      sessions: env.sessions,
      tasks: env.tasks,
      now: () => t,
    });
    try {
      // 1 回目
      w.handle({ type: "session.event", session_id: "s1", kind: "prompt", ts: 1000 });
      env.tasks.pull("s1");
      // 10 秒後 → debounce で skip
      t += 10;
      w.handle({ type: "session.event", session_id: "s1", kind: "prompt", ts: 1010 });
      expect(env.tasks.pull("s1")).toHaveLength(0);
      // 30 秒以上経過後 → 再 enqueue
      t += 25;
      w.handle({ type: "session.event", session_id: "s1", kind: "prompt", ts: 1035 });
      expect(env.tasks.pull("s1")).toHaveLength(1);
    } finally { w.stop(); }
  });

  it("session が存在しない stat.collected は無視", () => {
    const w = startRepoChangeWatcher({ sessions: env.sessions, tasks: env.tasks });
    try {
      w.handle({ type: "stat.collected", session_id: "ghost", stat_id: 1, ts: 1000 });
      expect(w.peekCache().lastRepoPath.has("ghost")).toBe(false);
    } finally { w.stop(); }
  });

  it("関係ない event は素通し", () => {
    startSession(env.sessions, "s1", "/repo/A");
    const w = startRepoChangeWatcher({ sessions: env.sessions, tasks: env.tasks });
    try {
      w.handle({ type: "ping", ts: 1000 });
      expect(w.peekCache().lastRepoPath.size).toBe(0);
    } finally { w.stop(); }
  });
});
