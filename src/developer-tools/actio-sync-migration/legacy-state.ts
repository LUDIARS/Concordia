/**
 * M5 の Cc 側。taskflow_task_state の行を読み、参照 (task_path) を置き換える。
 * 移行で Cc の DB に直接書くのはこの置き換えだけ。Actio 参照へ置き換えるときは、実行時の
 * registerActioReference と同じく actio_task_id も同じ id にそろえる (片方だけだと所有の照合で拒否される)。
 */
import Database from "better-sqlite3";
import type { MigrationStateRow } from "../../taskflow/sync-migration-types.js";

export interface LegacyStateAccess {
  currentRow(repoPath: string, taskPath: string): MigrationStateRow | null;
  replaceTaskPath(repoPath: string, from: string, to: string, actioTaskId: string | null): boolean;
  close(): void;
}

/** 旧 md の行は区切りが \ のまま保存されていることがある。どちらの表記でも引く。 */
function storedPaths(taskPath: string): string[] {
  return [...new Set([taskPath, taskPath.replace(/\//g, "\\")])];
}

export function openLegacyState(dbPath: string): LegacyStateAccess {
  const db = new Database(dbPath, { fileMustExist: true });
  const select = db.prepare(`SELECT repo_path, task_path, status, actio_task_id, delegation_run_id, updated_at, subsidiary_id
    FROM taskflow_task_state WHERE repo_path = ? AND task_path = ?`);
  const exists = db.prepare("SELECT 1 FROM taskflow_task_state WHERE repo_path = ? AND task_path = ?");
  const replace = db.prepare(`UPDATE taskflow_task_state SET task_path = ?, actio_task_id = COALESCE(?, actio_task_id)
    WHERE repo_path = ? AND task_path = ? AND actio_task_id IS NULL`);
  const find = (repoPath: string, taskPath: string): MigrationStateRow | null => {
    for (const path of storedPaths(taskPath)) {
      const row = select.get(repoPath, path) as MigrationStateRow | undefined;
      if (row) return row;
    }
    return null;
  };
  return {
    currentRow: find,
    replaceTaskPath: (repoPath, from, to, actioTaskId) => db.transaction(() => {
      const row = find(repoPath, from);
      if (!row || exists.get(repoPath, to)) return false;
      return replace.run(to, actioTaskId, repoPath, row.task_path).changes === 1;
    })(),
    close: () => db.close(),
  };
}
