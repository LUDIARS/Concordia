import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations, SCHEMA_VERSION } from "../src/db/schema.js";

describe("schema", () => {
  it("creates tables and indexes", () => {
    const db = new Database(":memory:");
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
});
