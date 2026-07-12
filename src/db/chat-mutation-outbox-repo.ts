import type Database from "better-sqlite3";

export interface ChatMutationOutboxRow {
  id: number;
  method: string;
  path: string;
  body_json: string | null;
  attempts: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export class ChatMutationOutboxRepo {
  constructor(private readonly db: Database.Database) {}

  enqueue(input: { method: string; path: string; bodyJson: string | null }, now = Date.now()): number {
    const result = this.db.prepare(
      `INSERT INTO chat_mutation_outbox(method, path, body_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(input.method, input.path, input.bodyJson, now, now);
    return Number(result.lastInsertRowid);
  }

  list(limit = 50): ChatMutationOutboxRow[] {
    return this.db.prepare(
      `SELECT * FROM chat_mutation_outbox ORDER BY created_at ASC, id ASC LIMIT ?`,
    ).all(Math.max(1, Math.min(500, limit))) as ChatMutationOutboxRow[];
  }

  remove(id: number): void {
    this.db.prepare(`DELETE FROM chat_mutation_outbox WHERE id = ?`).run(id);
  }

  markAttempt(id: number, error: string, now = Date.now()): void {
    this.db.prepare(
      `UPDATE chat_mutation_outbox
       SET attempts = attempts + 1, last_error = ?, updated_at = ?
       WHERE id = ?`,
    ).run(error.slice(0, 1000), now, id);
  }
}
