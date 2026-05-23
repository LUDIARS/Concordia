// 永続 WS クライアント + stat-collect retry の挙動テスト.
//
// WS そのもの (net 接続) はここでは扱わず、 repo API レベルで
// 1) ws_clients 増減で sweeper.findStaleActive から除外されること
// 2) requeueForRetry が delivered_at をクリアして retries++ すること
// 3) markResponded で以降 requeue されなくなること
// を検証する.

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../src/db/schema.js";
import { SessionsRepo } from "../src/db/sessions-repo.js";
import { TasksRepo } from "../src/db/tasks-repo.js";

function fresh() {
  const db = new Database(":memory:");
  applyMigrations(db);
  return { db, sessions: new SessionsRepo(db), tasks: new TasksRepo(db) };
}

function makeSession(repo: SessionsRepo, id: string, lastSeen: number): void {
  repo.insertSession({
    id,
    provider: "claude-code",
    repo_path: "/repo",
    repo_origin: null,
    branch: null,
    host: "h",
    started_at: lastSeen,
    last_seen_at: lastSeen,
    transcript_path: null,
    metadata: null,
  });
}

describe("ws_clients gating", () => {
  let env: ReturnType<typeof fresh>;
  beforeEach(() => { env = fresh(); });

  it("findStaleActive excludes sessions with ws_clients > 0", () => {
    const now = 100_000;
    const cutoff = now - 1800;
    makeSession(env.sessions, "a", cutoff - 100); // 古い
    makeSession(env.sessions, "b", cutoff - 100); // 古い

    // 何もしない時は両方 stale
    expect(env.sessions.findStaleActive(cutoff).map((s) => s.id).sort()).toEqual(["a", "b"]);

    // a に WS 接続が来た → stale から除外
    env.sessions.incrementWsClients("a");
    expect(env.sessions.findStaleActive(cutoff).map((s) => s.id)).toEqual(["b"]);
  });

  it("incrementWsClients touches last_seen_at and accepts multiple clients", () => {
    makeSession(env.sessions, "a", 0);
    const c1 = env.sessions.incrementWsClients("a");
    const c2 = env.sessions.incrementWsClients("a");
    expect(c1).toBe(1);
    expect(c2).toBe(2);
    const row = env.sessions.findSession("a")!;
    expect(row.ws_clients).toBe(2);
    expect(row.last_seen_at).toBeGreaterThan(0);
  });

  it("decrementWsClients floors at 0", () => {
    makeSession(env.sessions, "a", 0);
    env.sessions.incrementWsClients("a"); // 1
    env.sessions.decrementWsClients("a"); // 0
    env.sessions.decrementWsClients("a"); // 0 (床)
    const row = env.sessions.findSession("a")!;
    expect(row.ws_clients).toBe(0);
  });

  it("resetAllWsClients zeroes everything (boot-time integrity)", () => {
    makeSession(env.sessions, "a", 0);
    makeSession(env.sessions, "b", 0);
    env.sessions.incrementWsClients("a");
    env.sessions.incrementWsClients("a");
    env.sessions.incrementWsClients("b");
    expect(env.sessions.resetAllWsClients()).toBe(2);
    expect(env.sessions.findSession("a")?.ws_clients).toBe(0);
    expect(env.sessions.findSession("b")?.ws_clients).toBe(0);
  });
});

describe("pending_tasks retry", () => {
  let env: ReturnType<typeof fresh>;
  beforeEach(() => { env = fresh(); });

  function enqueueStat(sessionId: string): number {
    const t = env.tasks.enqueue({ session_id: sessionId, kind: "stat-collect", payload: {} });
    return t.id;
  }

  it("requeueForRetry returns nothing when no task delivered", () => {
    enqueueStat("a");
    const r = env.tasks.requeueForRetry({ kinds: ["stat-collect"] });
    expect(r).toHaveLength(0);
  });

  it("requeueForRetry returns delivered+stale tasks and clears delivered_at + bumps retries", () => {
    enqueueStat("a");
    const pulled = env.tasks.pull("a");
    expect(pulled).toHaveLength(1);
    const taskId = pulled[0].id;
    const deliveredAt = pulled[0].delivered_at!;

    // 直後は last_attempt_at が新しいので retry 対象外
    expect(env.tasks.requeueForRetry({ kinds: ["stat-collect"] })).toHaveLength(0);

    // 5 分 + 1 秒経過したことに見立てる (now を渡す)
    const after = deliveredAt + 5 * 60 + 1;
    const requeued = env.tasks.requeueForRetry({ kinds: ["stat-collect"], now: after });
    expect(requeued).toHaveLength(1);
    expect(requeued[0].id).toBe(taskId);
    expect(requeued[0].retries).toBe(1);

    // 再 pull で取れる
    const repulled = env.tasks.pull("a");
    expect(repulled).toHaveLength(1);
    expect(repulled[0].id).toBe(taskId);
    expect(repulled[0].retries).toBe(1);
  });

  it("requeueForRetry stops after maxRetries", () => {
    enqueueStat("a");
    let now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 5; i++) {
      env.tasks.pull("a");
      now += 5 * 60 + 1;
      env.tasks.requeueForRetry({ kinds: ["stat-collect"], now });
    }
    const task = env.tasks.find(1)!;
    // retries が 3 (デフォルト) で頭打ち + 4 回目以降は requeue されない
    expect(task.retries).toBeLessThanOrEqual(3);
  });

  it("markResponded prevents further requeue", () => {
    enqueueStat("a");
    const [pulled] = env.tasks.pull("a");
    const deliveredAt = pulled.delivered_at!;
    env.tasks.markResponded("a", ["stat-collect"]);

    const after = deliveredAt + 5 * 60 + 1;
    const requeued = env.tasks.requeueForRetry({ kinds: ["stat-collect"], now: after });
    expect(requeued).toHaveLength(0);
  });

  it("requeueForRetry filters by kinds[]", () => {
    env.tasks.enqueue({ session_id: "a", kind: "stat-collect", payload: {} });
    env.tasks.enqueue({ session_id: "a", kind: "chitchat-suggest", payload: {} });
    env.tasks.pull("a");
    const after = Math.floor(Date.now() / 1000) + 5 * 60 + 1;

    // stat-collect のみ retry
    const r = env.tasks.requeueForRetry({ kinds: ["stat-collect"], now: after });
    expect(r.map((t) => t.kind)).toEqual(["stat-collect"]);
  });
});
