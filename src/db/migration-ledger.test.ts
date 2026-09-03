import { describe, expect, it } from "vitest";

import { FROZEN_MIGRATIONS, SCHEMA_FINGERPRINT, schemaFingerprint } from "./migration-ledger.js";
import { migrationChecksum, runMigrations } from "./migrator.js";
import { MIGRATIONS, SCHEMA_VERSION } from "./schema.js";
import Database from "better-sqlite3";

/**
 * 適用済み migration を後から編集すると、 その場では何も起きず、 次に誰かがサービスを
 * 再起動した瞬間に `migration checksum mismatch` で起動不能になる。 2026-08-04 と
 * 2026-08-08 の 2 回、 実際に Concordia がこれで止まった。 ここが落ちる変更は、
 * 本番 DB の台帳を手で直さない限りマージしてはいけない。
 */
const EDIT_APPLIED_MIGRATION = [
  "適用済み migration が編集されている。",
  "新しいテーブル / 列は既存 migration を書き換えず、 末尾に番号付き migration を足すこと。",
  "凍結値の書き換えが正当なのは、 本番 DB の schema_migrations を同時に直すときだけ。",
].join("\n");

describe("migration ledger", () => {
  const frozen = new Map(FROZEN_MIGRATIONS.map((entry) => [entry.version, entry]));

  it("freezes every migration that ships", () => {
    const shipped = MIGRATIONS.map((migration) => migration.version).sort((a, b) => a - b);
    const pinned = FROZEN_MIGRATIONS.map((entry) => entry.version).sort((a, b) => a - b);
    // 凍結漏れ (足したのに凍結していない) と、 消滅 (凍結されているのに実装が無い) の
    // 両方をここで捕まえる。 後者は migration をこっそり削った変更。
    expect(pinned).toEqual(shipped);
  });

  it("keeps the declared schema version at the latest shipped migration", () => {
    expect(SCHEMA_VERSION).toBe(Math.max(...MIGRATIONS.map((migration) => migration.version)));
  });

  it("keeps the checksum of every applied migration", () => {
    for (const migration of MIGRATIONS) {
      const entry = frozen.get(migration.version);
      expect(entry, `version ${migration.version} は凍結台帳に無い`).toBeDefined();
      expect(migration.name, EDIT_APPLIED_MIGRATION).toBe(entry?.name);
      expect(migrationChecksum(migration), `${migration.version}:${migration.name}\n${EDIT_APPLIED_MIGRATION}`)
        .toBe(entry?.checksum);
    }
  });

  it("keeps the schema that the migrations produce", () => {
    // checksum は version / name / source しか見ないので、 source を据え置いたまま
    // up() の SQL だけ書き換えると素通りする。 その場合起動は通るが、 DB の中身が
    // 「いつ作られたか」で変わり、 環境ごとにスキーマが割れる。
    const db = new Database(":memory:");
    try {
      runMigrations(db, MIGRATIONS, SCHEMA_VERSION);
      expect(schemaFingerprint(db), EDIT_APPLIED_MIGRATION).toBe(SCHEMA_FINGERPRINT);
    } finally {
      db.close();
    }
  });

  it("writes exactly the frozen checksums into a fresh ledger", () => {
    // 凍結値が「実装から再計算した値」ではなく「DB に実際に載る値」であることを、
    // migrator を通して確かめる。 ここが一致していれば、 本番 DB の schema_migrations と
    // 同じものを凍結している。
    const db = new Database(":memory:");
    try {
      runMigrations(db, MIGRATIONS, SCHEMA_VERSION);
      const rows = db.prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version")
        .all() as Array<{ version: number; name: string; checksum: string }>;
      expect(rows).toEqual(FROZEN_MIGRATIONS.map((entry) => ({
        version: entry.version,
        name: entry.name,
        checksum: entry.checksum,
      })));
    } finally {
      db.close();
    }
  });

  it("refuses a migration whose checksum changed after it was applied", () => {
    // ゲートが本当に噛むことの確認。適用済み DB に編集を模した migration を渡すと落ちる。
    const db = new Database(":memory:");
    try {
      runMigrations(db, MIGRATIONS, SCHEMA_VERSION);
      const edited = MIGRATIONS.map((migration) => migration.version === 41
        ? { ...migration, source: `${migration.source} /* edited */` }
        : migration);
      expect(() => runMigrations(db, edited, SCHEMA_VERSION))
        .toThrow("migration checksum mismatch at 41:baseline-v41");
    } finally {
      db.close();
    }
  });
});
