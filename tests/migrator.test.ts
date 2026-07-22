import { describe, expect, it } from "vitest";
import { makeRawTestDb } from "./helpers/db.js";
import { runMigrations, type NumberedMigration } from "../src/db/migrator.js";

describe("numbered migrator", () => {
  it("rolls schema changes and ledger back as one transaction", () => {
    const db = makeRawTestDb();
    const broken: NumberedMigration = {
      version: 1,
      name: "broken",
      source: "create then fail",
      up(database) {
        database.exec("CREATE TABLE partial_change(id INTEGER)");
        throw new Error("boom");
      },
    };
    expect(() => runMigrations(db, [broken], 1)).toThrow("boom");
    expect(db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'partial_change'`,
    ).get()).toBeUndefined();
    expect(db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'`,
    ).get()).toBeUndefined();
  });

  it("rejects edits to an already applied migration checksum", () => {
    const db = makeRawTestDb();
    const migration = (source: string): NumberedMigration => ({
      version: 1,
      name: "baseline",
      source,
      up(database) { database.exec("CREATE TABLE stable(id INTEGER)"); },
    });
    runMigrations(db, [migration("v1")], 1);
    expect(() => runMigrations(db, [migration("edited")], 1)).toThrow(/checksum mismatch/);
  });
});
