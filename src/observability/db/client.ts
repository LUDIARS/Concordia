/**
 * Observability (Excubitor 由来) の Drizzle クライアント.
 *
 * Concordia は既に better-sqlite3 + applyMigrations() の独自パターンを持つ. 重複して
 * DB を開かず、 既存の `currentDb()` (better-sqlite3 Database インスタンス) を
 * そのまま drizzle-orm/better-sqlite3 でラップする.
 *
 * 元 Excubitor: drizzle-orm/postgres-js + postgres 接続プール.
 * 本実装: 同一 Database インスタンスの上に Drizzle を被せるだけ.
 */

import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { currentDb } from '../../db/index.js';
import * as schema from './schema.js';

let _db: BetterSQLite3Database<typeof schema> | null = null;

export function db(): BetterSQLite3Database<typeof schema> {
  if (!_db) {
    _db = drizzle(currentDb(), { schema });
  }
  return _db;
}

export { schema };
