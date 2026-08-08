/**
 * `session_message_reads` — ブラウザ client (`client_id`, ローカル生成 UUID) ごとの
 * 既読位置 (spec/feature/session-message-layer.md §3.4)。 未読状態はセッション全体では
 * なく client 単位。
 */

import type Database from "better-sqlite3";

export interface SessionMessageReadRow {
  client_id: string;
  session_id: string;
  last_read_id: number;
  updated_at: number;
}

export class SessionMessageReadsRepo {
  constructor(private readonly db: Database.Database) {}

  upsert(client_id: string, session_id: string, last_read_id: number, updated_at: number): void {
    this.db
      .prepare(
        `INSERT INTO session_message_reads(client_id, session_id, last_read_id, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(client_id, session_id) DO UPDATE SET
           last_read_id = MAX(session_message_reads.last_read_id, excluded.last_read_id),
           updated_at = excluded.updated_at`,
      )
      .run(client_id, session_id, last_read_id, updated_at);
  }

  get(client_id: string, session_id: string): SessionMessageReadRow | null {
    const row = this.db
      .prepare(
        `SELECT client_id, session_id, last_read_id, updated_at
           FROM session_message_reads WHERE client_id = ? AND session_id = ?`,
      )
      .get(client_id, session_id) as SessionMessageReadRow | undefined;
    return row ?? null;
  }
}
