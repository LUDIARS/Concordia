/**
 * M6: 状態の写しのずれ (spec/faq/actio-cc-task-project-sync.md §5)。
 * Cc の taskflow_task_state.status と Actio の status を突き合わせて一覧にする。
 * 適用は照合ジョブ (taskflow/state-reconcile.ts) が行う — 移行で Cc の列を直接書かない。
 */
import { workflowStatus } from "./actio-task-client.js";
import type { MigrationActioTask, MigrationStateRow } from "./sync-migration-types.js";

export interface StatusDriftEntry { reference: string; repo_path: string; cc: string; actio: string }

export function planStatusDrift(rows: readonly MigrationStateRow[], tasks: readonly MigrationActioTask[]): {
  drift: StatusDriftEntry[]; missing_in_actio: string[];
} {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const drift: StatusDriftEntry[] = [];
  const missing: string[] = [];
  for (const row of rows) {
    if (!row.actio_task_id) continue;
    const task = byId.get(row.actio_task_id);
    if (!task) { missing.push(`actio:${row.actio_task_id}`); continue; }
    const actio = workflowStatus(task.status);
    if (actio !== row.status) drift.push({ reference: `actio:${task.id}`, repo_path: row.repo_path, cc: row.status, actio });
  }
  return { drift, missing_in_actio: missing };
}
