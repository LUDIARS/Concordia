import type Database from "better-sqlite3";

/**
 * Excubitor へ移管済みで Concordia から参照されない旧 observability tables。
 * foreign key の子から親へ落とす順序を固定する。
 */
export const OBSOLETE_EXCUBITOR_TABLES = [
  "auto_fix_runs",
  "error_tasks",
  "error_rules",
  "service_instance_logs",
  "liveness_history",
  "service_instances",
  "services",
  "hosts",
  "audit_log",
] as const;

export function findObsoleteExcubitorTables(db: Database.Database): string[] {
  const existing = new Set(
    (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
        .all() as Array<{ name: string }>
    ).map((row) => row.name),
  );
  return OBSOLETE_EXCUBITOR_TABLES.filter((table) => existing.has(table));
}

export function dropObsoleteExcubitorTables(db: Database.Database): string[] {
  const obsolete = findObsoleteExcubitorTables(db);
  if (obsolete.length === 0) return [];

  const drop = db.transaction(() => {
    for (const table of obsolete) db.exec(`DROP TABLE ${table}`);
  });
  drop();

  // VACUUM は transaction 内で実行できない。サービス停止を確認した外部CLIだけが呼ぶ。
  db.exec("VACUUM");
  return obsolete;
}
