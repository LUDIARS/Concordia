import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { NIGHTLY_VACUUM_CRON, startNightlyVacuum } from "./nightly-vacuum.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeBloatedDatabase(): { db: Database.Database; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), "concordia-nightly-vacuum-"));
  tempDirs.push(root);
  const dbPath = join(root, "concordia.db");
  const db = new Database(dbPath);
  db.exec("CREATE TABLE bulk (id INTEGER PRIMARY KEY, payload TEXT)");
  const insert = db.prepare("INSERT INTO bulk (payload) VALUES (?)");
  const fill = db.transaction(() => {
    for (let i = 0; i < 2000; i++) insert.run("x".repeat(1024));
  });
  fill();
  db.exec("DELETE FROM bulk");
  return { db, dbPath };
}

describe("nightly vacuum", () => {
  it("runs at 03:00 JST", () => {
    expect(NIGHTLY_VACUUM_CRON).toBe("0 3 * * *");
  });

  it("reclaims freed pages on runOnce", () => {
    const { db, dbPath } = makeBloatedDatabase();
    const handle = startNightlyVacuum({ db, dbPath });
    try {
      const before = statSync(dbPath).size;
      handle.runOnce();
      const after = statSync(dbPath).size;
      expect(after).toBeLessThan(before);
      // VACUUM 後も DB は開いたまま使える
      expect(db.prepare("SELECT COUNT(*) AS n FROM bulk").get()).toEqual({ n: 0 });
    } finally {
      handle.stop();
      db.close();
    }
  });

  it("keeps the process alive-safe when vacuum fails", () => {
    const { db, dbPath } = makeBloatedDatabase();
    const handle = startNightlyVacuum({ db, dbPath });
    try {
      db.close(); // 閉じたハンドルで VACUUM を失敗させる
      expect(() => handle.runOnce()).not.toThrow();
    } finally {
      handle.stop();
    }
  });
});
