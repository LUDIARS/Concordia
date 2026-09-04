import type Database from "better-sqlite3";

/**
 * `inbox_item_state` — 承認インボックスの既読・スヌーズ (spec/feature/approval-inbox.md §2)。
 *
 * **UI 状態専用。** 回答・解決の正本は各項目の元テーブルで、 ここに書いても人が答えた
 * ことにはならない。 既読は `client_id` (ブラウザ生成 UUID) ごと — 同じ未回答事項でも
 * 「自分は見た / 相方はまだ」が別々に要るため (session_message_reads と同じ方式)。
 *
 * `item_key` は read model が種別と正本の主キーから決定的に作る。 正本が消えれば
 * 二度と現れないキーなので、 残った行は掃除できる。
 *
 * @implements spec/feature/approval-inbox.md §2
 */

export interface InboxItemState {
  readonly readAt: number | null;
  readonly snoozedUntil: number | null;
}

export class InboxItemStateRepo {
  constructor(private readonly db: Database.Database) {}

  /** client 1 人分をまとめて引く。 一覧は毎回全項目に state を付けるので 1 クエリで読む。 */
  allFor(clientId: string): Map<string, InboxItemState> {
    const rows = this.db
      .prepare(`SELECT item_key, read_at, snoozed_until FROM inbox_item_state WHERE client_id = ?`)
      .all(clientId) as Array<{ item_key: string; read_at: number | null; snoozed_until: number | null }>;
    const out = new Map<string, InboxItemState>();
    for (const row of rows) {
      out.set(row.item_key, { readAt: row.read_at, snoozedUntil: row.snoozed_until });
    }
    return out;
  }

  markRead(clientId: string, itemKey: string, at: number): void {
    this.#upsert(clientId, itemKey, at, { readAt: at });
  }

  /** 既読を取り消す。 「あとで見る」に戻せないと、 一度開いただけで見失う。 */
  markUnread(clientId: string, itemKey: string, at: number): void {
    this.#upsert(clientId, itemKey, at, { readAt: null });
  }

  /** `until` が過去なら解除と同じ。 呼び出し側で分岐させない。 */
  snooze(clientId: string, itemKey: string, at: number, until: number | null): void {
    this.#upsert(clientId, itemKey, at, { snoozedUntil: until });
  }

  /**
   * 正本から消えた項目の行を捨てる。 スヌーズしたまま回答された項目の行が残り続けると、
   * client ごとに単調増加する。
   */
  pruneMissing(liveKeys: ReadonlySet<string>): number {
    const rows = this.db.prepare(`SELECT client_id, item_key FROM inbox_item_state`).all() as
      Array<{ client_id: string; item_key: string }>;
    const remove = this.db.prepare(`DELETE FROM inbox_item_state WHERE client_id = ? AND item_key = ?`);
    let removed = 0;
    for (const row of rows) {
      if (liveKeys.has(row.item_key)) continue;
      remove.run(row.client_id, row.item_key);
      removed += 1;
    }
    return removed;
  }

  /** 片方だけ更新する。 既読を付けてもスヌーズは消さない (別々の操作なので)。 */
  #upsert(
    clientId: string,
    itemKey: string,
    at: number,
    patch: { readAt?: number | null; snoozedUntil?: number | null },
  ): void {
    const hasRead = "readAt" in patch;
    const hasSnooze = "snoozedUntil" in patch;
    this.db
      .prepare(`
        INSERT INTO inbox_item_state(client_id, item_key, read_at, snoozed_until, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(client_id, item_key) DO UPDATE SET
          read_at = ${hasRead ? "excluded.read_at" : "inbox_item_state.read_at"},
          snoozed_until = ${hasSnooze ? "excluded.snoozed_until" : "inbox_item_state.snoozed_until"},
          updated_at = excluded.updated_at
      `)
      .run(clientId, itemKey, patch.readAt ?? null, patch.snoozedUntil ?? null, at);
  }
}
