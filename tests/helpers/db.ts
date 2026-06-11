/**
 * テスト用 in-memory SQLite ファクトリ.
 *
 * `new Database(":memory:") + applyMigrations(db)` の逐語コピーを置き換える。
 * 生成した DB は cleanup レジストリに登録され、テスト終了後に必ず close される
 * (better-sqlite3 のネイティブハンドルは GC 任せにするとスイート全体で蓄積する)。
 */

import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations } from "../../src/db/schema.js";
import { registerCleanup } from "./cleanup.js";

export function makeTestDb(): Database.Database {
  const db = new Database(":memory:");
  applyMigrations(db);
  registerCleanup(() => db.close());
  return db;
}

/** migration を適用しない生の in-memory DB (schema.test 等の migration 検証用)。 */
export function makeRawTestDb(): Database.Database {
  const db = new Database(":memory:");
  registerCleanup(() => db.close());
  return db;
}

/** テスト終了後に自動削除されるテンポラリディレクトリ。 */
export function makeTestDir(prefix = "concordia-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  registerCleanup(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
