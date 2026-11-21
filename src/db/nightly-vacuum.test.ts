import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NIGHTLY_VACUUM_CRON,
  VACUUM_RECOMMEND_FREE_RATIO,
  readFreePageStats,
  startNightlyVacuum,
} from "./nightly-vacuum.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** rows 行を入れたあと deleteAll なら全行を、 そうでなければ何も消さない DB を作る。 */
function makeDatabase(deleteAll: boolean): { db: Database.Database; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), "concordia-nightly-vacuum-"));
  tempDirs.push(root);
  const dbPath = join(root, "concordia.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE bulk (id INTEGER PRIMARY KEY, payload TEXT)");
  const insert = db.prepare("INSERT INTO bulk (payload) VALUES (?)");
  const fill = db.transaction(() => {
    for (let i = 0; i < 2000; i++) insert.run("x".repeat(1024));
  });
  fill();
  if (deleteAll) db.exec("DELETE FROM bulk");
  db.pragma("wal_checkpoint(PASSIVE)"); // freelist をヘッダへ反映させる (TRUNCATE ではない)
  return { db, dbPath };
}

/** VACUUM と TRUNCATE checkpoint が本体プロセスで一度も流れていないことを確かめる。 */
function spyMaintenanceCalls(db: Database.Database) {
  const exec = vi.spyOn(db, "exec");
  const pragma = vi.spyOn(db, "pragma");
  return {
    vacuumCalls: () => exec.mock.calls.filter(([sql]) => /\bVACUUM\b/i.test(String(sql))).length,
    truncateCalls: () => pragma.mock.calls.filter(([p]) => /wal_checkpoint\s*\(\s*TRUNCATE/i.test(String(p))).length,
  };
}

describe("nightly vacuum (空き率点検)", () => {
  it("runs at 03:00 JST", () => {
    expect(NIGHTLY_VACUUM_CRON).toBe("0 3 * * *");
  });

  it("空き率が閾値未満なら skip し、 VACUUM も TRUNCATE checkpoint も流さない", async () => {
    const { db, dbPath } = makeDatabase(false);
    const handle = startNightlyVacuum({ db, dbPath });
    const spies = spyMaintenanceCalls(db);
    try {
      const sizeBefore = statSync(dbPath).size;
      const outcome = await handle.runOnce();
      expect(outcome.action).toBe("skipped");
      if (outcome.action !== "skipped") throw new Error("unreachable");
      expect(outcome.free_ratio).toBeLessThan(VACUUM_RECOMMEND_FREE_RATIO);
      expect(outcome.page_count).toBeGreaterThan(0);
      expect(spies.vacuumCalls()).toBe(0);
      expect(spies.truncateCalls()).toBe(0);
      expect(statSync(dbPath).size).toBe(sizeBefore);
    } finally {
      handle.stop();
      db.close();
    }
  });

  it("空き率が閾値以上でも本体では VACUUM せず、 保守窓での実行を求めるだけ", async () => {
    const { db, dbPath } = makeDatabase(true);
    const handle = startNightlyVacuum({ db, dbPath });
    const spies = spyMaintenanceCalls(db);
    try {
      const freeBefore = readFreePageStats(db).freelist_pages;
      const outcome = await handle.runOnce();
      expect(outcome.action).toBe("maintenance_recommended");
      if (outcome.action !== "maintenance_recommended") throw new Error("unreachable");
      expect(outcome.free_ratio).toBeGreaterThanOrEqual(VACUUM_RECOMMEND_FREE_RATIO);
      expect(spies.vacuumCalls()).toBe(0);
      expect(spies.truncateCalls()).toBe(0);
      // 空きページは回収されずに残る (VACUUM が走っていない裏付け)
      expect(readFreePageStats(db).freelist_pages).toBe(freeBefore);
      expect(db.prepare("SELECT COUNT(*) AS n FROM bulk").get()).toEqual({ n: 0 });
    } finally {
      handle.stop();
      db.close();
    }
  });

  it("点検に失敗しても例外を投げず failed を返す", async () => {
    const { db, dbPath } = makeDatabase(true);
    const handle = startNightlyVacuum({ db, dbPath });
    try {
      db.close(); // 閉じたハンドルで pragma を失敗させる
      const outcome = await handle.runOnce();
      expect(outcome.action).toBe("failed");
    } finally {
      handle.stop();
    }
  });
});
