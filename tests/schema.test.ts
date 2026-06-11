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

    const v = db.prepare(`SELECT value FROM schema_meta WHERE key = 'version'`).get() as { value: string };
    expect(Number(v.value)).toBe(SCHEMA_VERSION);
  });

  it("personas table has display_name column on fresh DB", () => {
    const db = makeRawTestDb();
    applyMigrations(db);
    const cols = db.prepare(`PRAGMA table_info(personas)`).all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === "display_name")).toBe(true);
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
});
