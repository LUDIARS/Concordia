import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

export interface NumberedMigration {
  version: number;
  name: string;
  source: string;
  up(db: Database.Database): void;
}

export function migrationChecksum(migration: Pick<NumberedMigration, "version" | "name" | "source">): string {
  return createHash("sha256")
    .update(`${migration.version}\n${migration.name}\n${migration.source}`, "utf8")
    .digest("hex");
}

/**
 * The only schema writer. BEGIN IMMEDIATE serializes competing processes,
 * while the ledger checksum prevents an applied migration from being edited.
 * Schema changes, backfills, the ledger row, and schema_meta advance atomically.
 */
export function runMigrations(
  db: Database.Database,
  migrations: readonly NumberedMigration[],
  targetVersion: number,
): void {
  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  const versions = new Set<number>();
  for (const migration of ordered) {
    if (!Number.isInteger(migration.version) || migration.version <= 0 || versions.has(migration.version)) {
      throw new Error(`invalid or duplicate migration version: ${migration.version}`);
    }
    versions.add(migration.version);
  }

  const migrate = db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      checksum   TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`);

    const appliedRows = db.prepare(
      `SELECT version, name, checksum FROM schema_migrations ORDER BY version`,
    ).all() as Array<{ version: number; name: string; checksum: string }>;
    const applied = new Map(appliedRows.map((row) => [row.version, row]));
    for (const migration of ordered) {
      const checksum = migrationChecksum(migration);
      const prior = applied.get(migration.version);
      if (prior) {
        if (prior.name !== migration.name || prior.checksum !== checksum) {
          throw new Error(`migration checksum mismatch at ${migration.version}:${migration.name}`);
        }
        continue;
      }
      migration.up(db);
      db.prepare(
        `INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)`,
      ).run(migration.version, migration.name, checksum, Date.now());
    }
    db.prepare(
      `INSERT INTO schema_meta(key, value) VALUES('version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(String(targetVersion));
  });

  migrate.immediate();
}
