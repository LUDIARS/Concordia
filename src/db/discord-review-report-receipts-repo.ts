import type Database from "better-sqlite3";

/**
 * Test Forum 詳細レポートの配送受領台帳 (migration 107)。
 *
 * 受領印を Discord 投稿へ表示しないため、配送済みかどうかは Cc が正本として持つ。
 * pending は送信を始めたが応答で確定できていない行で、次の配送前にスレッド履歴と照合する。
 */
export interface DiscordReviewReportReceiptRow {
  report_key: string;
  state: "pending" | "delivered";
  message_id: string | null;
  /** epoch ミリ秒。 pending では送信を始めた時刻。 */
  attempted_at: number;
}

export interface DiscordReviewReportReceiptsRepo {
  list(threadId: string): DiscordReviewReportReceiptRow[];
  /** 旧版 footer 受領印の取り込みを完了したスレッドか。 */
  hasImportedLegacyReceipts(threadId: string): boolean;
  /** 旧受領印で配送済みと確認した鍵と取り込み完了を 1 transaction で記録する。 */
  importLegacyReceipts(threadId: string, reportKeys: readonly string[]): void;
  /** 送信直前の記録。 配送済みの行は pending へ戻さない。 */
  markPending(threadId: string, reportKey: string, attemptedAtMs: number): void;
  markDelivered(threadId: string, reportKey: string, messageId: string | null): void;
  /** 届いていないと照合できた pending を捨てる。 配送済みの行は消さない。 */
  forgetPending(threadId: string, reportKey: string): void;
}

export function makeDiscordReviewReportReceiptsRepo(
  db: Database.Database,
  scope = "",
  nowMs: () => number = () => Date.now(),
): DiscordReviewReportReceiptsRepo {
  const insertDelivered = db.prepare(
    `INSERT INTO discord_review_report_receipts
       (scope, thread_id, report_key, state, message_id, attempted_at)
     VALUES (?, ?, ?, 'delivered', ?, ?)
     ON CONFLICT(scope, thread_id, report_key) DO UPDATE
       SET state = 'delivered',
           message_id = COALESCE(excluded.message_id, discord_review_report_receipts.message_id)`,
  );
  const importLegacy = db.transaction((threadId: string, reportKeys: readonly string[]) => {
    const at = nowMs();
    for (const reportKey of reportKeys) insertDelivered.run(scope, threadId, reportKey, null, at);
    db.prepare(
      `INSERT INTO discord_review_report_threads (scope, thread_id, legacy_receipts_imported_at)
       VALUES (?, ?, ?)
       ON CONFLICT(scope, thread_id) DO NOTHING`,
    ).run(scope, threadId, at);
  });
  return {
    list(threadId) {
      return db.prepare(
        `SELECT report_key, state, message_id, attempted_at
           FROM discord_review_report_receipts
          WHERE scope = ? AND thread_id = ?
          ORDER BY attempted_at, report_key`,
      ).all(scope, threadId) as DiscordReviewReportReceiptRow[];
    },
    hasImportedLegacyReceipts(threadId) {
      return !!db.prepare(
        "SELECT 1 FROM discord_review_report_threads WHERE scope = ? AND thread_id = ?",
      ).get(scope, threadId);
    },
    importLegacyReceipts(threadId, reportKeys) {
      importLegacy(threadId, reportKeys);
    },
    markPending(threadId, reportKey, attemptedAtMs) {
      db.prepare(
        `INSERT INTO discord_review_report_receipts
           (scope, thread_id, report_key, state, message_id, attempted_at)
         VALUES (?, ?, ?, 'pending', NULL, ?)
         ON CONFLICT(scope, thread_id, report_key) DO UPDATE
           SET attempted_at = excluded.attempted_at
         WHERE discord_review_report_receipts.state = 'pending'`,
      ).run(scope, threadId, reportKey, attemptedAtMs);
    },
    markDelivered(threadId, reportKey, messageId) {
      insertDelivered.run(scope, threadId, reportKey, messageId, nowMs());
    },
    forgetPending(threadId, reportKey) {
      db.prepare(
        `DELETE FROM discord_review_report_receipts
          WHERE scope = ? AND thread_id = ? AND report_key = ? AND state = 'pending'`,
      ).run(scope, threadId, reportKey);
    },
  };
}
