import type Database from "better-sqlite3";

export type PendingTaskKind =
  | "chitchat-suggest"
  | "chat-reply"
  | "review-summary"
  | "daily-report"
  | "session-departed"
  | "peer-log-react"
  | "stat-collect"
  | "title-suggest";

export interface PendingTaskRow {
  id: number;
  session_id: string;
  kind: PendingTaskKind;
  payload: string; // JSON
  created_at: number;
  delivered_at: number | null;
  expires_at: number;
  /** retry 回数. 0 = 初回。 上限到達で諦める. */
  retries: number;
  /** 直近の配信試行 ts (delivered_at と同じ値か、 retry で更新). */
  last_attempt_at: number | null;
}

const DEFAULT_TTL_SEC = 30 * 60; // 30 分
const DEFAULT_RETRY_AFTER_SEC = 5 * 60; // 配信後 5 分応答なしで retry 対象
const DEFAULT_MAX_RETRIES = 3;

export class TasksRepo {
  constructor(private readonly db: Database.Database) {}

  enqueue(input: {
    session_id: string;
    kind: PendingTaskKind;
    payload: object;
    ttlSec?: number;
  }): PendingTaskRow {
    const now = Math.floor(Date.now() / 1000);
    const ttl = input.ttlSec ?? DEFAULT_TTL_SEC;
    const r = this.db
      .prepare(
        `INSERT INTO pending_tasks(session_id, kind, payload, created_at, delivered_at, expires_at)
         VALUES (?, ?, ?, ?, NULL, ?)`,
      )
      .run(input.session_id, input.kind, JSON.stringify(input.payload), now, now + ttl);
    return this.find(Number(r.lastInsertRowid))!;
  }

  /**
   * Pull undelivered tasks for a session and mark delivered.
   * 返却後すぐ消費される想定 (hook の出力にしか使わない).
   */
  pull(sessionId: string, limit = 20): PendingTaskRow[] {
    const now = Math.floor(Date.now() / 1000);
    const rows = this.db
      .prepare(
        `SELECT * FROM pending_tasks
         WHERE session_id = ? AND delivered_at IS NULL AND expires_at > ?
         ORDER BY created_at ASC LIMIT ?`,
      )
      .all(sessionId, now, limit) as PendingTaskRow[];
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const placeholder = ids.map(() => "?").join(",");
    this.db
      .prepare(
        `UPDATE pending_tasks
           SET delivered_at = ?, last_attempt_at = ?
         WHERE id IN (${placeholder})`,
      )
      .run(now, now, ...ids);
    return rows.map((r) => ({ ...r, delivered_at: now, last_attempt_at: now }));
  }

  /**
   * 配信済みだが session が応答していない (= 同じ session の新規 prompt event が来てない or
   * 後段の chat 投稿が無い) task を retry 対象として delivered_at=NULL に戻す.
   *
   * dispatcher / sweeper から呼び出され、 「配信から retryAfterSec 秒経過、 retries < maxRetries」
   * の条件を満たす task を再送可能にする.
   *
   * 「応答有無」 の判断はここでは行わず、 呼び出し側が `markRespondedSince` で応答済 task を
   * 切り分けてから再送候補を本関数に渡す.
   */
  requeueForRetry(opts: {
    retryAfterSec?: number;
    maxRetries?: number;
    now?: number;
    kinds?: PendingTaskKind[];
  } = {}): PendingTaskRow[] {
    const now = opts.now ?? Math.floor(Date.now() / 1000);
    const retryAfter = opts.retryAfterSec ?? DEFAULT_RETRY_AFTER_SEC;
    const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    const kindFilter = opts.kinds && opts.kinds.length > 0
      ? ` AND kind IN (${opts.kinds.map(() => "?").join(",")})`
      : "";
    const args: unknown[] = [now - retryAfter, maxRetries, now];
    if (opts.kinds) args.push(...opts.kinds);
    const candidates = this.db
      .prepare(
        `SELECT * FROM pending_tasks
         WHERE delivered_at IS NOT NULL
           AND last_attempt_at IS NOT NULL
           AND last_attempt_at < ?
           AND retries < ?
           AND expires_at > ?${kindFilter}`,
      )
      .all(...args) as PendingTaskRow[];
    if (candidates.length === 0) return [];
    const ids = candidates.map((r) => r.id);
    const placeholder = ids.map(() => "?").join(",");
    this.db
      .prepare(
        `UPDATE pending_tasks
           SET delivered_at = NULL, retries = retries + 1
         WHERE id IN (${placeholder})`,
      )
      .run(...ids);
    return candidates.map((r) => ({ ...r, delivered_at: null, retries: r.retries + 1 }));
  }

  /**
   * 配信済 task を「応答受信扱い」 にする (= retry 対象から外す).
   * delivered_at は保持しつつ retries を MAX に上げて以降 requeue されないようにする.
   * 「session が新 prompt event を投げた」 等で応答とみなす経路から呼ぶ.
   */
  markResponded(sessionId: string, kinds?: PendingTaskKind[], now = Math.floor(Date.now() / 1000)): number {
    const kindFilter = kinds && kinds.length > 0
      ? ` AND kind IN (${kinds.map(() => "?").join(",")})`
      : "";
    const args: unknown[] = [DEFAULT_MAX_RETRIES + 1, sessionId];
    if (kinds) args.push(...kinds);
    const r = this.db
      .prepare(
        `UPDATE pending_tasks
           SET retries = ?
         WHERE session_id = ? AND delivered_at IS NOT NULL${kindFilter}`,
      )
      .run(...args);
    return Number(r.changes ?? 0);
  }

  /**
   * 指定 session で、 指定 kind の pending task が created_at >= sinceTs の範囲で
   * 既に存在するか (delivered/undelivered/expired 問わず).
   * idle stat-collect の「最後の指示以降に 1 回だけ」 抑止に使う.
   */
  hasTaskSince(sessionId: string, kind: PendingTaskKind, sinceTs: number): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM pending_tasks
         WHERE session_id = ? AND kind = ? AND created_at >= ?
         LIMIT 1`,
      )
      .get(sessionId, kind, sinceTs);
    return row !== undefined;
  }

  /**
   * 指定 session の **未配信** (delivered_at IS NULL) かつ **未期限切れ** な
   * pending task の数. session-status-card で「Concordia から待たせている
   * 依頼の件数」 を表示する用途.
   */
  countUndeliveredForSession(sessionId: string, now?: number): number {
    const t = now ?? Math.floor(Date.now() / 1000);
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM pending_tasks
         WHERE session_id = ? AND delivered_at IS NULL AND expires_at > ?`,
      )
      .get(sessionId, t) as { n: number };
    return row.n;
  }

  /**
   * 指定 session の指定 kind で「未配信 (delivered_at IS NULL) かつ未失効」 の
   * pending task が存在するか. stat-collect の二重 enqueue 抑止などに使う.
   */
  hasUndelivered(sessionId: string, kind: PendingTaskKind, now = Math.floor(Date.now() / 1000)): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM pending_tasks
         WHERE session_id = ? AND kind = ?
           AND delivered_at IS NULL AND expires_at > ?
         LIMIT 1`,
      )
      .get(sessionId, kind, now);
    return row !== undefined;
  }

  find(id: number): PendingTaskRow | null {
    return (
      (this.db
        .prepare(`SELECT * FROM pending_tasks WHERE id = ?`)
        .get(id) as PendingTaskRow | undefined) ?? null
    );
  }

  purgeExpired(now = Math.floor(Date.now() / 1000)): number {
    const r = this.db
      .prepare(`DELETE FROM pending_tasks WHERE expires_at < ?`)
      .run(now);
    return Number(r.changes ?? 0);
  }
}
