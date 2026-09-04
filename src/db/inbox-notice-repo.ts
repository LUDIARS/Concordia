import type Database from "better-sqlite3";

/**
 * ダイジェスト投稿と催促の「最後にいつ出したか」だけを持つ小さな表。
 *
 * **未回答事項の正本ではない。** 何が未回答かは read model が既存テーブルから毎回読む。
 * ここが持つのは通知側の都合 (二重投稿と再催促の抑止) だけで、 消えても回答状態は変わらない。
 *
 * @implements spec/feature/approval-inbox.md §3
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

  /** 指定 prefix の記録をまとめて引く (催促は項目ごとにキーが増えるので 1 クエリで読む)。 */
  allWithPrefix(prefix: string): Map<string, number> {
    const rows = this.db
      .prepare(`SELECT key, last_at FROM inbox_notice_state WHERE key LIKE ? || '%'`)
      .all(prefix) as Array<{ key: string; last_at: number }>;
    const out = new Map<string, number>();
    for (const row of rows) out.set(row.key.slice(prefix.length), row.last_at);
    return out;
  }

  mark(key: string, at: number): void {
    this.db
      .prepare(`
        INSERT INTO inbox_notice_state(key, last_at) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET last_at = excluded.last_at
      `)
      .run(key, at);
  }

  /**
   * 解決済み項目の催促記録を捨てる。 項目キーは正本の主キー由来なので、 回答されると
   * 二度と現れない。 残しておくと表が単調増加する。
   */
  pruneMissing(prefix: string, liveKeys: ReadonlySet<string>): number {
    const rows = this.db
      .prepare(`SELECT key FROM inbox_notice_state WHERE key LIKE ? || '%'`)
      .all(prefix) as Array<{ key: string }>;
    const remove = this.db.prepare(`DELETE FROM inbox_notice_state WHERE key = ?`);
    let removed = 0;
    for (const row of rows) {
      if (liveKeys.has(row.key.slice(prefix.length))) continue;
      remove.run(row.key);
      removed += 1;
    }
    return removed;
  }
}
