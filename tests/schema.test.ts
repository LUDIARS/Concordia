import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { applyMigrations, SCHEMA_VERSION } from "../src/db/schema.js";
import { makeRawTestDb } from "./helpers/db.js";

describe("schema", () => {
  it("creates tables and indexes", () => {
    const db = makeRawTestDb();
    applyMigrations(db);
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("sessions");
    expect(names).toContain("session_events");
    expect(names).toContain("session_reports");
    expect(names).toContain("slack_session_channels");
    expect(names).toContain("slack_session_threads");
    expect(names).toContain("schema_meta");
    expect(names).toContain("federation_sites");
    expect(names).toContain("federation_outbox");
    expect(names).not.toContain("liveness_history");
    expect(names).not.toContain("service_instance_logs");

    const v = db.prepare(`SELECT value FROM schema_meta WHERE key = 'version'`).get() as { value: string };
    expect(Number(v.value)).toBe(SCHEMA_VERSION);
  });

  it("does not create persona tables on fresh DB (persona 機構撤去済み)", () => {
    const db = makeRawTestDb();
    applyMigrations(db);
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).not.toContain("personas");
    expect(names).not.toContain("persona_assignments");
    expect(names).not.toContain("persona_feedback_log");
  });

  it("forum migration columns exist on a fresh DB", () => {
    const db = makeRawTestDb();
    applyMigrations(db);
    const templateColumns = db.prepare(`PRAGMA table_info(delegation_templates)`).all() as Array<{ name: string }>;
    const sessionColumns = db.prepare(`PRAGMA table_info(discord_session_channels)`).all() as Array<{ name: string }>;
    const testSurfaceColumns = db.prepare(`PRAGMA table_info(discord_test_surfaces)`).all() as Array<{ name: string }>;
    expect(templateColumns.some((column) => column.name === "forum_tag")).toBe(true);
    expect(sessionColumns.some((column) => column.name === "surface_message_id")).toBe(true);
    expect(testSurfaceColumns.some((column) => column.name === "repo_root_path")).toBe(true);
    expect(testSurfaceColumns.some((column) => column.name === "head_branch")).toBe(true);
  });

  it("leaves orphan persona tables in legacy DB untouched (孤児テーブル放置)", () => {
    const db = makeRawTestDb();
    // legacy DB: 旧 persona 機構のテーブルが残っている状態
    db.exec(`CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    db.exec(`CREATE TABLE personas (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      traits TEXT NOT NULL DEFAULT '[]', speech_style TEXT NOT NULL DEFAULT '',
      skill_template TEXT NOT NULL DEFAULT '', learned_notes TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`);
    db.prepare(`INSERT INTO personas (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .run("legacy", "旧人格", 1, 1);

    // 撤去後の migration がエラー無く通り、孤児テーブルは drop されない
    applyMigrations(db);
    const row = db.prepare(`SELECT name FROM personas WHERE id = 'legacy'`).get() as { name: string };
    expect(row.name).toBe("旧人格");

    // 2回目もエラー無く通る
    applyMigrations(db);
  });

  it("leaves obsolete Excubitor tables to the external maintenance command", () => {
    const db = makeRawTestDb();
    db.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO schema_meta(key, value) VALUES('version', '34');
      CREATE TABLE hosts (id TEXT PRIMARY KEY);
      CREATE TABLE services (id TEXT PRIMARY KEY);
      CREATE TABLE service_instances (id TEXT PRIMARY KEY);
      CREATE TABLE liveness_history (id INTEGER PRIMARY KEY);
      CREATE TABLE service_instance_logs (id INTEGER PRIMARY KEY);
      CREATE TABLE error_rules (id TEXT PRIMARY KEY);
      CREATE TABLE error_tasks (id TEXT PRIMARY KEY);
      CREATE TABLE auto_fix_runs (id TEXT PRIMARY KEY);
      CREATE TABLE audit_log (id INTEGER PRIMARY KEY);
    `);

    applyMigrations(db);
    const obsolete = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN (
           'hosts', 'services', 'service_instances', 'liveness_history',
           'service_instance_logs', 'error_rules', 'error_tasks', 'auto_fix_runs', 'audit_log'
         )`,
      )
      .all();
    expect(obsolete).toHaveLength(9);
    expect(
      db.prepare(`SELECT value FROM schema_meta WHERE key = 'version'`).get(),
    ).toEqual({ value: String(SCHEMA_VERSION) });

    expect(() => applyMigrations(db)).not.toThrow();
  });
});

// migration 44 は「旧リアクションWF allowlist → 社員名簿の管理職」の一度きりの移行。
// ここが落ちるとアップグレード直後に spawn / 発火できる人間が 0 人になるので、
// 取り込み・`*` 破棄・env フォールバックの 3 点を固定する
// (spec/feature/staff-roster.md §4)。
describe("migration 44: reaction allowlist → staff roster", () => {
  const ENV_KEYS = [
    "CONCORDIA_REACTION_WORKFLOW_DISCORD_USERS",
    "CONCORDIA_REACTION_WORKFLOW_SLACK_USERS",
  ] as const;
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    // 実行環境の .env が漏れてくると期待値が揺れるので、毎回明示的に外す。
    for (const key of ENV_KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function seedLegacyAllowlist(db: ReturnType<typeof makeRawTestDb>, key: string, value: string) {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    db.prepare(`INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, ?)`).run(key, value);
  }

  function roster(db: ReturnType<typeof makeRawTestDb>) {
    return db
      .prepare(`SELECT platform, platform_user_id, role FROM staff_members ORDER BY platform, platform_user_id`)
      .all() as Array<{ platform: string; platform_user_id: string; role: string }>;
  }

  it("imports persisted allowlist IDs as 管理職 and drops the * sentinel", () => {
    const db = makeRawTestDb();
    seedLegacyAllowlist(db, "admin.reaction_workflow_discord_users", JSON.stringify(["d1", "d2"]));
    seedLegacyAllowlist(db, "admin.reaction_workflow_slack_users", JSON.stringify(["*", "s1"]));

    applyMigrations(db);

    expect(roster(db)).toEqual([
      { platform: "discord", platform_user_id: "d1", role: "manager" },
      { platform: "discord", platform_user_id: "d2", role: "manager" },
      { platform: "slack", platform_user_id: "s1", role: "manager" },
    ]);
    // 再適用しても重複行を作らない (migration 台帳で 1 度きり)。
    applyMigrations(db);
    expect(roster(db)).toHaveLength(3);
  });

  it("falls back to the retired env allowlist when nothing was persisted", () => {
    process.env.CONCORDIA_REACTION_WORKFLOW_DISCORD_USERS = "d1, d2;d3";
    const db = makeRawTestDb();

    applyMigrations(db);

    expect(roster(db)).toEqual([
      { platform: "discord", platform_user_id: "d1", role: "manager" },
      { platform: "discord", platform_user_id: "d2", role: "manager" },
      { platform: "discord", platform_user_id: "d3", role: "manager" },
    ]);
  });

  it("treats a persisted empty allowlist as authoritative over the env fallback", () => {
    process.env.CONCORDIA_REACTION_WORKFLOW_DISCORD_USERS = "d1";
    const db = makeRawTestDb();
    seedLegacyAllowlist(db, "admin.reaction_workflow_discord_users", "[]");

    applyMigrations(db);

    expect(roster(db)).toEqual([]);
  });

  it("creates an empty roster on a fresh DB with no legacy configuration", () => {
    const db = makeRawTestDb();
    applyMigrations(db);
    expect(roster(db)).toEqual([]);
  });
});
