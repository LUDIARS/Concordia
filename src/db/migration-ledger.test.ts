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

  it("keeps SCHEMA_VERSION aligned with the newest migration", () => {
    expect(SCHEMA_VERSION).toBe(Math.max(...MIGRATIONS.map((migration) => migration.version)));
  });

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

  it("adds plan request identity without changing shipped migrations or historic questions", () => {
    const db = new Database(":memory:");
    try {
      runMigrations(db, MIGRATIONS.filter((migration) => migration.version <= 128), 128);
      db.prepare("INSERT INTO discord_pending_questions(session_id,question,options_json,ts) VALUES (?,?,?,?)")
        .run("legacy-session", "historic question", '["yes","no"]', 1);
      const frozenBefore = db.prepare("SELECT version,name,checksum FROM schema_migrations ORDER BY version").all();

      runMigrations(db, MIGRATIONS, SCHEMA_VERSION);

      expect(db.prepare("SELECT version,name,checksum FROM schema_migrations WHERE version <= 128 ORDER BY version").all())
        .toEqual(frozenBefore);
      expect(db.prepare("SELECT question,kind,provider_request_id FROM discord_pending_questions WHERE session_id=?").get("legacy-session"))
        .toEqual({ question: "historic question", kind: "question", provider_request_id: null });
      expect(db.prepare("SELECT name FROM schema_migrations WHERE version=?").get(131))
        .toEqual({ name: "provider-plan-approval-identity" });
      const insert = db.prepare("INSERT INTO discord_pending_questions(session_id,question,options_json,ts,kind,provider_request_id) VALUES (?,?,?,?,?,?)");
      insert.run("plan-a", "approve", "[]", 2, "plan_approval", "request-1");
      expect(() => insert.run("plan-a", "approve", "[]", 3, "plan_approval", "request-1"))
        .toThrow(/UNIQUE constraint failed/);
      expect(() => insert.run("plan-b", "approve", "[]", 3, "plan_approval", "request-1"))
        .not.toThrow();
    } finally {
      db.close();
    }
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

  it("adds personal budget at 129 without changing an applied 128 ledger or usage budget", () => {
    const db = new Database(":memory:");
    try {
      runMigrations(db, MIGRATIONS.filter((entry) => entry.version <= 128), 128);
      db.prepare("INSERT INTO usage_budgets(scope,target_id,limit_tokens,updated_at) VALUES ('user','prior-user',123,1)").run();
      const before = db.prepare("SELECT version,name,checksum FROM schema_migrations ORDER BY version").all();
      runMigrations(db, MIGRATIONS, SCHEMA_VERSION);
      expect(db.prepare("SELECT value FROM schema_meta WHERE key='version'").get()).toEqual({ value: String(SCHEMA_VERSION) });
      expect(db.prepare("SELECT version,name,checksum FROM schema_migrations WHERE version <= 128 ORDER BY version").all()).toEqual(before);
      expect(db.prepare("SELECT limit_tokens FROM usage_budgets WHERE target_id='prior-user'").get()).toEqual({ limit_tokens: 123 });
      expect(db.prepare("SELECT name FROM schema_migrations WHERE version=129").get()).toEqual({ name: "personal-ai-budget" });
      for (const name of ["personal_budget_people", "personal_budget_monthly_usage", "personal_budget_session_seen", "personal_budget_ledger"]) {
        expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name)).toEqual({ name });
      }
      const columns = db.prepare("PRAGMA table_info(subsidiaries)").all() as Array<{ name: string; dflt_value: string | null }>;
      expect(columns.find((column) => column.name === "personal_monthly_token_budget")?.dflt_value).toBe("0");
      runMigrations(db, MIGRATIONS, SCHEMA_VERSION);
      expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version=129").get()).toEqual({ count: 1 });
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
