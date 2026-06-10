/**
 * cost budget の永続層 (cost_daily_usage / cost_log_seen)。
 *
 *  - cost_daily_usage: local 日ごとの累積消費トークン。 予算判定の母数。
 *  - cost_log_seen   : ログファイル単位の「最後に観測した累積トークン」。
 *                      再起動を跨いで delta の二重計上を防ぐ baseline。
 */

import type Database from "better-sqlite3";

export class CostBudgetRepo {
  constructor(private readonly db: Database.Database) {}

  /** 指定日 (local "YYYY-MM-DD") の累積消費トークン。 無ければ 0。 */
  getDayTokens(dateIso: string): number {
    const row = this.db
      .prepare(`SELECT tokens FROM cost_daily_usage WHERE date_iso = ?`)
      .get(dateIso) as { tokens: number } | undefined;
    return row?.tokens ?? 0;
  }

  /** 指定日に delta トークンを加算する (負値は無視)。 */
  addDayTokens(dateIso: string, delta: number, now: number): void {
    if (!Number.isFinite(delta) || delta <= 0) return;
    this.db
      .prepare(
        `INSERT INTO cost_daily_usage(date_iso, tokens, updated_at) VALUES(?, ?, ?)
         ON CONFLICT(date_iso) DO UPDATE SET tokens = tokens + excluded.tokens, updated_at = excluded.updated_at`,
      )
      .run(dateIso, Math.floor(delta), now);
  }

  /** ログファイルの最後に観測した累積トークン (無ければ null = 未観測)。 */
  getLogLastTotal(logPath: string): number | null {
    const row = this.db
      .prepare(`SELECT last_total FROM cost_log_seen WHERE log_path = ?`)
      .get(logPath) as { last_total: number } | undefined;
    return row?.last_total ?? null;
  }

  /** ログファイルの観測累積を更新する。 */
  setLogLastTotal(logPath: string, total: number, now: number): void {
    this.db
      .prepare(
        `INSERT INTO cost_log_seen(log_path, last_total, updated_at) VALUES(?, ?, ?)
         ON CONFLICT(log_path) DO UPDATE SET last_total = excluded.last_total, updated_at = excluded.updated_at`,
      )
      .run(logPath, Math.floor(total), now);
  }

  /** 古い cost_log_seen 行を掃除する (mtime 監視窓を超えたファイルの baseline は不要)。 */
  pruneLogSeen(olderThan: number): void {
    this.db.prepare(`DELETE FROM cost_log_seen WHERE updated_at < ?`).run(olderThan);
  }
}
