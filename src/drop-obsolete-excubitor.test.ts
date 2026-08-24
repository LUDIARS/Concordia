import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OBSOLETE_EXCUBITOR_TABLES } from "./db/obsolete-excubitor-cleanup.js";
import { main } from "./drop-obsolete-excubitor.js";

const tempDirs: string[] = [];

/** 深夜帯 (23:00–05:00) 内の固定時刻。 テストの実行時刻に依存させない。 */
const QUIET_HOURS_NOW = new Date(2026, 7, 24, 3, 0, 0);

/** 深夜帯の外 (日中) の固定時刻。 */
const DAYTIME_NOW = new Date(2026, 7, 24, 12, 0, 0);

function makeDatabase(): { dbPath: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "concordia-obsolete-drop-"));
  tempDirs.push(root);
  const dbPath = join(root, "concordia.db");
  const db = new Database(dbPath);
  try {
    db.exec("CREATE TABLE retained_data (id INTEGER PRIMARY KEY)");
    for (const table of OBSOLETE_EXCUBITOR_TABLES) {
      db.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY)`);
    }
  } finally {
    db.close();
  }
  return { dbPath, root };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("drop obsolete Excubitor CLI", () => {
  it("defaults to a non-mutating dry-run", async () => {
    const { dbPath } = makeDatabase();
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await main(["--db", dbPath]);

    expect(output).toHaveBeenCalledWith(expect.stringContaining('"mode":"dry-run"'));
    const db = new Database(dbPath, { readonly: true });
    try {
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'services'").get()).toBeTruthy();
    } finally {
      db.close();
    }
  });

  it("requires both an explicit backup and stopped-services confirmation", async () => {
    const { dbPath, root } = makeDatabase();
    await expect(main(["--db", dbPath, "--apply"], QUIET_HOURS_NOW)).rejects.toThrow("--confirm-services-stopped");
    await expect(main([
      "--db", dbPath,
      "--apply",
      "--confirm-services-stopped",
    ], QUIET_HOURS_NOW)).rejects.toThrow("--backup");
    expect(existsSync(join(root, "backup.bak"))).toBe(false);
  });

  it("refuses --apply during daytime unless --allow-daytime is passed", async () => {
    const { dbPath, root } = makeDatabase();
    const backupPath = join(root, "backup.bak");
    await expect(main([
      "--db", dbPath,
      "--backup", backupPath,
      "--apply",
      "--confirm-services-stopped",
    ], DAYTIME_NOW)).rejects.toThrow("quiet hours");
    expect(existsSync(backupPath)).toBe(false);

    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await main([
      "--db", dbPath,
      "--backup", backupPath,
      "--apply",
      "--confirm-services-stopped",
      "--allow-daytime",
    ], DAYTIME_NOW);
    expect(existsSync(backupPath)).toBe(true);
  });

  it("backs up, verifies, drops and vacuums on explicit apply", async () => {
    const { dbPath, root } = makeDatabase();
    const backupPath = join(root, "backup.bak");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await main([
      "--db", dbPath,
      "--backup", backupPath,
      "--apply",
      "--confirm-services-stopped",
    ], QUIET_HOURS_NOW);

    expect(existsSync(backupPath)).toBe(true);
    const db = new Database(dbPath, { readonly: true });
    const backup = new Database(backupPath, { readonly: true });
    try {
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'services'").get()).toBeUndefined();
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'retained_data'").get()).toBeTruthy();
      expect(backup.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(backup.prepare("SELECT name FROM sqlite_master WHERE name = 'services'").get()).toBeTruthy();
    } finally {
      db.close();
      backup.close();
    }
  });
});
