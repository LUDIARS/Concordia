import { describe, it, expect, beforeEach } from "vitest";
import { makeTestDb } from "./helpers/db.js";
import { SessionsRepo } from "../src/db/sessions-repo.js";
import { TasksRepo } from "../src/db/tasks-repo.js";
import { StatsRepo } from "../src/db/stats-repo.js";
import {
  startStatScheduler,
  STAT_POLL_INTERVAL_SEC,
  IDLE_STAT_THRESHOLD_SEC,
} from "../src/stat/scheduler.js";

function fresh() {
  const db = makeTestDb();
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

  it("interval は last_seen が 10 分以上前なら飛ばさない (idle トリガで拾うので enq 自体は 1 になる)", () => {
    const NOW = 100_000;
    // last_seen が古い session. 直近 stat 無し、 prompt event 無し (started_at=1).
    // interval poll は last_seen ゲートで skip するが、 idle トリガが拾う.
    startSession(env.sessions, "stale", { lastSeenAt: NOW - (STAT_POLL_INTERVAL_SEC + 5) });
    const sched = startStatScheduler({ ...env, now: () => NOW, tickMs: 60_000 });
    try {
      expect(sched.runOnce()).toBe(1);
      const pulled = env.tasks.pull("stale");
      expect(pulled).toHaveLength(1);
      expect(JSON.parse(pulled[0].payload).trigger).toBe("idle");
    } finally { sched.stop(); }
  });

  it("interval も idle も飛ばさない: 直近に stat + 直近に prompt がある場合", () => {
    const NOW = 100_000;
    startSession(env.sessions, "active-fresh", { lastSeenAt: NOW - 10 });
    env.stats.insert({ session_id: "active-fresh", ts: NOW - 60, payload: { recent_work: "x" } });
    env.sessions.appendEvent({ session_id: "active-fresh", ts: NOW - 30, kind: "prompt", payload: {} });
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
    // idle session: last_seen は古い (interval は飛ばない) かつ prompt が無い & started_at も古い
    // → idle トリガで 1 本 enqueue される. enq=2 になる.
    startSession(env.sessions, "idle", { lastSeenAt: NOW - (STAT_POLL_INTERVAL_SEC + 100) });
    startSession(env.sessions, "lost-one", { lastSeenAt: NOW - 10, status: "lost" });
    const sched = startStatScheduler({ ...env, now: () => NOW, tickMs: 60_000 });
    try {
      expect(sched.runOnce()).toBe(2);
      expect(env.tasks.pull("ok").find((t) => t.kind === "stat-collect")).toBeTruthy();
      const idlePulled = env.tasks.pull("idle");
      expect(idlePulled).toHaveLength(1);
      expect(idlePulled[0].kind).toBe("stat-collect");
      expect(env.tasks.pull("lost-one")).toHaveLength(0);
    } finally { sched.stop(); }
  });

  // ─── idle トリガ (5 分指示なし) ─────────────────────────────────

  function startSessionAt(repo: SessionsRepo, id: string, startedAt: number, lastSeenAt: number) {
    repo.insertSession({
      id, provider: "claude-code",
      repo_path: "/x", repo_origin: null, branch: "main",
      host: "h",
      started_at: startedAt, last_seen_at: lastSeenAt,
      transcript_path: null, metadata: null,
    });
  }

  it("idle: prompt が 5 分以上前ならアイドルとして stat-collect を 1 本 enqueue する", () => {
    const NOW = 1_000_000;
    // last_seen は新しい (自律 AI 活動中) けれど 指示は 5 分以上来てない
    startSessionAt(env.sessions, "autonomous", NOW - 60 * 60, NOW - 5);
    env.sessions.appendEvent({
      session_id: "autonomous",
      ts: NOW - IDLE_STAT_THRESHOLD_SEC - 30,
      kind: "prompt",
      payload: { summary: "古い指示" },
    });
    // 直近 stat は数秒前 → interval poll は引っかからない
    env.stats.insert({ session_id: "autonomous", ts: NOW - 10, payload: {} });

    const sched = startStatScheduler({ ...env, now: () => NOW, tickMs: 60_000 });
    try {
      expect(sched.runOnce()).toBe(1);
      const pulled = env.tasks.pull("autonomous");
      expect(pulled).toHaveLength(1);
      expect(pulled[0].kind).toBe("stat-collect");
      const payload = JSON.parse(pulled[0].payload);
      expect(payload.trigger).toBe("idle");
    } finally { sched.stop(); }
  });

  it("idle: 一度 enqueue した後は同じ idle stretch では再発火しない", () => {
    const NOW = 1_000_000;
    startSessionAt(env.sessions, "s", NOW - 60 * 60, NOW - 5);
    env.sessions.appendEvent({
      session_id: "s",
      ts: NOW - IDLE_STAT_THRESHOLD_SEC - 30,
      kind: "prompt",
      payload: {},
    });
    env.stats.insert({ session_id: "s", ts: NOW - 10, payload: {} });

    const sched = startStatScheduler({ ...env, now: () => NOW, tickMs: 60_000 });
    try {
      expect(sched.runOnce()).toBe(1); // 初回 idle 発火 (task created_at=NOW)
      env.tasks.pull("s"); // 受け取り消費 — created_at は残るので再発火されない
      expect(sched.runOnce()).toBe(0);
    } finally { sched.stop(); }
  });

  it("idle: 新しい prompt 後に再び idle になったら再発火する", () => {
    // dedup: hasTaskSince(sessionId, "stat-collect", lastPrompt) が判定根拠.
    // 新しい prompt が来て lastPrompt が更新されると、 その新しい lastPrompt 以降に
    // stat-collect が無いため再発火可能になる.
    const T1 = 1_000_000;
    const OLD_PROMPT = T1 - IDLE_STAT_THRESHOLD_SEC - 30;
    startSessionAt(env.sessions, "s2", T1 - 60 * 60, T1 - 5);
    env.sessions.appendEvent({ session_id: "s2", ts: OLD_PROMPT, kind: "prompt", payload: {} });
    env.stats.insert({ session_id: "s2", ts: T1 - 10, payload: {} });

    const sched = startStatScheduler({ ...env, now: () => T1, tickMs: 60_000 });
    try {
      // 1 回目: idle 発火。 scheduler は now=T1 で enqueue するため created_at=T1。
      expect(sched.runOnce()).toBe(1);
      env.tasks.pull("s2"); // 消費 — created_at=T1 は残る → hasTaskSince(OLD_PROMPT) = true

      // 2 回目 (同じ idle stretch): 再発火しない。
      expect(sched.runOnce()).toBe(0);

      // 新しい prompt イベントを追加 (T2 > OLD_PROMPT)。
      const T2 = T1 + 100;
      env.sessions.appendEvent({ session_id: "s2", ts: T2, kind: "prompt", payload: {} });

      // T3 = T2 + IDLE_STAT_THRESHOLD_SEC + 10 で再び idle 判定 (lastPrompt=T2 <= T3 - threshold)。
      // hasTaskSince(sessionId, "stat-collect", T2) → false (T1 のタスクは T2 より前) → 再発火。
      const T3 = T2 + IDLE_STAT_THRESHOLD_SEC + 10;
      const sched2 = startStatScheduler({ ...env, now: () => T3, tickMs: 60_000 });
      try {
        expect(sched2.runOnce()).toBe(1);
        const pulled = env.tasks.pull("s2");
        expect(pulled).toHaveLength(1);
        expect(JSON.parse(pulled[0].payload).trigger).toBe("idle");
      } finally {
        sched2.stop();
      }
    } finally {
      sched.stop();
    }
  });

  it("idle: prompt event が一度も無い session も started_at 起点で 5 分過ぎたら発火する", () => {
    const NOW = 1_000_000;
    // started_at が 10 分前、 last_seen は 5 秒前 (= 直近 stat あり想定)
    startSessionAt(env.sessions, "fresh-no-prompt", NOW - 10 * 60, NOW - 5);
    env.stats.insert({ session_id: "fresh-no-prompt", ts: NOW - 5, payload: {} });

    const sched = startStatScheduler({ ...env, now: () => NOW, tickMs: 60_000 });
    try {
      expect(sched.runOnce()).toBe(1);
      const pulled = env.tasks.pull("fresh-no-prompt");
      expect(pulled).toHaveLength(1);
      expect(JSON.parse(pulled[0].payload).trigger).toBe("idle");
    } finally { sched.stop(); }
  });

  it("idle: 5 分以内に prompt が来ているなら発火しない", () => {
    const NOW = 1_000_000;
    startSessionAt(env.sessions, "active-user", NOW - 60 * 60, NOW - 5);
    env.sessions.appendEvent({
      session_id: "active-user",
      ts: NOW - 60, // 1 分前
      kind: "prompt",
      payload: {},
    });
    env.stats.insert({ session_id: "active-user", ts: NOW - 5, payload: {} });

    const sched = startStatScheduler({ ...env, now: () => NOW, tickMs: 60_000 });
    try {
      expect(sched.runOnce()).toBe(0);
    } finally { sched.stop(); }
  });
});
