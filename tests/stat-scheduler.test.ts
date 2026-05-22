import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../src/db/schema.js";
import { SessionsRepo } from "../src/db/sessions-repo.js";
import { TasksRepo } from "../src/db/tasks-repo.js";
import { StatsRepo } from "../src/db/stats-repo.js";
import { startStatScheduler, STAT_POLL_INTERVAL_SEC } from "../src/stat/scheduler.js";

function fresh() {
  const db = new Database(":memory:");
  applyMigrations(db);
  return {
    db,
    sessions: new SessionsRepo(db),
    tasks: new TasksRepo(db),
    stats: new StatsRepo(db),
  };
}

function startSession(
  repo: SessionsRepo,
  id: string,
  opts: { lastSeenAt?: number; status?: "active" | "lost" | "ended" } = {},
) {
  repo.insertSession({
    id, provider: "claude-code",
    repo_path: "/x", repo_origin: null, branch: "main",
    host: "h",
    started_at: 1, last_seen_at: opts.lastSeenAt ?? 1000,
    transcript_path: null, metadata: null,
  });
  if (opts.status && opts.status !== "active") {
    repo.setStatus(id, opts.status, opts.lastSeenAt ?? 1000);
  }
}

describe("startStatScheduler", () => {
  let env: ReturnType<typeof fresh>;
  beforeEach(() => { env = fresh(); });

  it("enqueues stat-collect for active sessions that moved recently and have no stat yet", () => {
    const NOW = 100_000;
    startSession(env.sessions, "fresh", { lastSeenAt: NOW - 30 });
    const sched = startStatScheduler({ ...env, now: () => NOW, tickMs: 60_000 });
    try {
      const enq = sched.runOnce();
      expect(enq).toBe(1);
      const pulled = env.tasks.pull("fresh");
      expect(pulled.find((t) => t.kind === "stat-collect")).toBeTruthy();
    } finally {
      sched.stop();
    }
  });

  it("skips sessions not in active status", () => {
    const NOW = 100_000;
    startSession(env.sessions, "lost-one", { lastSeenAt: NOW - 30, status: "lost" });
    const sched = startStatScheduler({ ...env, now: () => NOW, tickMs: 60_000 });
    try {
      expect(sched.runOnce()).toBe(0);
    } finally { sched.stop(); }
  });

  it("skips sessions that have not moved within 10 minutes (idle)", () => {
    const NOW = 100_000;
    startSession(env.sessions, "idle", { lastSeenAt: NOW - (STAT_POLL_INTERVAL_SEC + 5) });
    const sched = startStatScheduler({ ...env, now: () => NOW, tickMs: 60_000 });
    try {
      expect(sched.runOnce()).toBe(0);
      expect(env.tasks.pull("idle")).toHaveLength(0);
    } finally { sched.stop(); }
  });

  it("skips sessions that already have a stat within last 10 minutes", () => {
    const NOW = 100_000;
    startSession(env.sessions, "recent-stat", { lastSeenAt: NOW - 10 });
    env.stats.insert({ session_id: "recent-stat", ts: NOW - 60, payload: { recent_work: "x" } });
    const sched = startStatScheduler({ ...env, now: () => NOW, tickMs: 60_000 });
    try {
      expect(sched.runOnce()).toBe(0);
    } finally { sched.stop(); }
  });

  it("re-enqueues after 10 minutes since last stat", () => {
    const NOW = 100_000;
    startSession(env.sessions, "old-stat", { lastSeenAt: NOW - 10 });
    env.stats.insert({ session_id: "old-stat", ts: NOW - (STAT_POLL_INTERVAL_SEC + 1), payload: {} });
    const sched = startStatScheduler({ ...env, now: () => NOW, tickMs: 60_000 });
    try {
      expect(sched.runOnce()).toBe(1);
    } finally { sched.stop(); }
  });

  it("does not double-enqueue when previous stat-collect is still pending undelivered", () => {
    const NOW = 100_000;
    startSession(env.sessions, "pending", { lastSeenAt: NOW - 10 });
    const sched = startStatScheduler({ ...env, now: () => NOW, tickMs: 60_000 });
    try {
      expect(sched.runOnce()).toBe(1);   // 1 回目で enqueue
      expect(sched.runOnce()).toBe(0);   // 2 回目は pending あり → skip
    } finally { sched.stop(); }
  });

  it("handles multiple sessions: some enqueued, some skipped", () => {
    const NOW = 100_000;
    startSession(env.sessions, "ok", { lastSeenAt: NOW - 10 });
    startSession(env.sessions, "idle", { lastSeenAt: NOW - (STAT_POLL_INTERVAL_SEC + 100) });
    startSession(env.sessions, "lost-one", { lastSeenAt: NOW - 10, status: "lost" });
    const sched = startStatScheduler({ ...env, now: () => NOW, tickMs: 60_000 });
    try {
      expect(sched.runOnce()).toBe(1);
      expect(env.tasks.pull("ok").find((t) => t.kind === "stat-collect")).toBeTruthy();
      expect(env.tasks.pull("idle")).toHaveLength(0);
      expect(env.tasks.pull("lost-one")).toHaveLength(0);
    } finally { sched.stop(); }
  });
});
