import { describe, it, expect } from "vitest";
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
    expect(names).toContain("schema_meta");
    expect(names).not.toContain("liveness_history");
    expect(names).not.toContain("service_instance_logs");

    const v = db.prepare(`SELECT value FROM schema_meta WHERE key = 'version'`).get() as { value: string };
    expect(Number(v.value)).toBe(SCHEMA_VERSION);
  });

  it("personas table has display_name column on fresh DB", () => {
    const db = makeRawTestDb();
    applyMigrations(db);
    const cols = db.prepare(`PRAGMA table_info(personas)`).all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === "display_name")).toBe(true);
  });

  it("forum migration columns exist on a fresh DB", () => {
    const db = makeRawTestDb();
    applyMigrations(db);
    const templateColumns = db.prepare(`PRAGMA table_info(delegation_templates)`).all() as Array<{ name: string }>;
    const sessionColumns = db.prepare(`PRAGMA table_info(discord_session_channels)`).all() as Array<{ name: string }>;
    expect(templateColumns.some((column) => column.name === "forum_tag")).toBe(true);
    expect(sessionColumns.some((column) => column.name === "surface_message_id")).toBe(true);
  });

  it("applyMigrations is idempotent and adds display_name to legacy personas", () => {
    const db = makeRawTestDb();
    // legacy schema: personas に display_name が無い状態
    db.exec(`CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    db.exec(`CREATE TABLE personas (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      traits TEXT NOT NULL DEFAULT '[]', speech_style TEXT NOT NULL DEFAULT '',
      skill_template TEXT NOT NULL DEFAULT '', learned_notes TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`);
    db.prepare(`INSERT INTO personas (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .run("legacy", "旧人格", 1, 1);

    applyMigrations(db);

    const cols = db.prepare(`PRAGMA table_info(personas)`).all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === "display_name")).toBe(true);
    const row = db.prepare(`SELECT display_name FROM personas WHERE id = 'legacy'`).get() as { display_name: string };
    expect(row.display_name).toBe("");

    // 2回目もエラー無く通る (column 重複 ALTER しない)
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
