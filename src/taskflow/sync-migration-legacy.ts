/**
 * M5: Cc にしか無い旧 md タスク (spec/tasks/*.md) の移行計画 (spec/faq/actio-cc-task-project-sync.md §5)。
 *
 * pending / delegated のものを、作業単位のキー `work:<repoKey>:<path>` で Actio に一度だけ作る案を出す。
 * それ以外の状態 (done など) は移さず archive の候補として並べる。全件移すか直近に絞るかは人が決める (§7)。
 */
import { repositoryKey } from "./actio-binding.js";
import type { MigrationStateRow } from "./sync-migration-types.js";

export interface LegacyTaskPlan {
  create: Array<{ repo_path: string; task_path: string; status: string; source_ref: string }>;
  archive: Array<{ repo_path: string; task_path: string; status: string }>;
}

const LEGACY_TASK_PATH = /^spec\/tasks\/.+\.md$/;
const ACTIVE = new Set(["pending", "delegated"]);

export function planLegacyTasks(rows: readonly MigrationStateRow[]): LegacyTaskPlan {
  const plan: LegacyTaskPlan = { create: [], archive: [] };
  for (const row of rows) {
    const path = row.task_path.replace(/\\/g, "/");
    if (row.actio_task_id || !LEGACY_TASK_PATH.test(path)) continue;
    if (ACTIVE.has(row.status)) {
      plan.create.push({ repo_path: row.repo_path, task_path: path, status: row.status,
        source_ref: `work:${repositoryKey(row.repo_path)}:${path}` });
    } else {
      plan.archive.push({ repo_path: row.repo_path, task_path: path, status: row.status });
    }
  }
  return plan;
}
