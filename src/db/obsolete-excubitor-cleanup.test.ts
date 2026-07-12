import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import {
  dropObsoleteExcubitorTables,
  findObsoleteExcubitorTables,
  OBSOLETE_EXCUBITOR_TABLES,
} from "./obsolete-excubitor-cleanup.js";

describe("obsolete Excubitor table cleanup", () => {
  it("drops only obsolete tables and is idempotent", () => {
    const db = makeTestDb();
    db.exec("CREATE TABLE retained_data (id INTEGER PRIMARY KEY)");
    for (const table of OBSOLETE_EXCUBITOR_TABLES) {
      db.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY)`);
    }

    expect(findObsoleteExcubitorTables(db)).toEqual([...OBSOLETE_EXCUBITOR_TABLES]);
    expect(dropObsoleteExcubitorTables(db)).toEqual([...OBSOLETE_EXCUBITOR_TABLES]);
    expect(findObsoleteExcubitorTables(db)).toEqual([]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'retained_data'").get()).toBeTruthy();
    expect(dropObsoleteExcubitorTables(db)).toEqual([]);
  });
});
