import type Database from "better-sqlite3";

export type PendingTaskKind =
  | "chitchat-suggest"
  | "chat-reply"
  | "review-summary"
  | "daily-report"
  | "session-departed";

export interface PendingTaskRow {
  id: number;
  session_id: string;
  kind: PendingTaskKind;
  payload: string; // JSON
  created_at: number;
  delivered_at: number | null;
  expires_at: number;
}

const DEFAULT_TTL_SEC = 30 * 60; // 30 分

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
      .prepare(`UPDATE pending_tasks SET delivered_at = ? WHERE id IN (${placeholder})`)
      .run(now, ...ids);
    return rows.map((r) => ({ ...r, delivered_at: now }));
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
