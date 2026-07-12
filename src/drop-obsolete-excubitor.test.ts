import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OBSOLETE_EXCUBITOR_TABLES } from "./db/obsolete-excubitor-cleanup.js";
import { main } from "./drop-obsolete-excubitor.js";

const tempDirs: string[] = [];

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
    await expect(main(["--db", dbPath, "--apply"])).rejects.toThrow("--confirm-services-stopped");
    await expect(main([
      "--db", dbPath,
      "--apply",
      "--confirm-services-stopped",
    ])).rejects.toThrow("--backup");
    expect(existsSync(join(root, "backup.bak"))).toBe(false);
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
    ]);

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
