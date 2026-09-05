import type Database from "better-sqlite3";

/**
 * ダイジェスト投稿と再訪通知の「最後にいつ出したか」だけを持つ小さな表。
 *
 * **未回答事項の正本ではない。** 何が未回答かは read model が既存テーブルから毎回読む。
 * ここが持つのは通知側の都合 (二重投稿の抑止) だけで、 消えても回答状態は変わらない。
 *
 * @implements spec/feature/approval-inbox.md §3.1-3.2
 */
export class InboxNoticeRepo {
  constructor(private readonly db: Database.Database) {}

  /** 最後に出した時刻 (epoch ms)。 一度も出していなければ null。 */
  lastAt(key: string): number | null {
    const row = this.db.prepare(`SELECT last_at FROM inbox_notice_state WHERE key = ?`).get(key) as
      | { last_at: number }
      | undefined;
    return row?.last_at ?? null;
  }

  mark(key: string, at: number): void {
    this.db
      .prepare(`
        INSERT INTO inbox_notice_state(key, last_at) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET last_at = excluded.last_at
      `)
      .run(key, at);
  }
}
