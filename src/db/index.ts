import Database from "better-sqlite3";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { applyMigrations } from "./schema.js";

let db: Database.Database | null = null;

/** WAL ファイルを checkpoint 後に切り詰める上限 (64MB)。 wal-guard.ts の警告閾値と揃える。 */
export const WAL_JOURNAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;

export function openDb(path: string): Database.Database {
  if (db) return db;
  mkdirSync(dirname(path), { recursive: true });
  db = new Database(path);
  applyMigrations(db);
  // WAL ファイルの上限。 既定 (-1 = 無制限) だと、 長時間リーダーに checkpoint を阻まれた
  // 間に膨らんだ WAL (2026-09-01 実測 375MB = DB 本体と同サイズ) が checkpoint 完了後も
  // 縮まず、 以降の毎コミットの自動 checkpoint 試行が数百 ms〜1 秒イベントループを止める。
  // checkpoint 完了時に 64MB まで切り詰める (spec/plan/2026-09-01-cc-event-loop-diet.md)。
  db.pragma(`journal_size_limit = ${WAL_JOURNAL_SIZE_LIMIT_BYTES}`);
  return db;
}

export function currentDb(): Database.Database {
  if (!db) throw new Error("Concordia DB is not open. Call openDb() first.");
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
