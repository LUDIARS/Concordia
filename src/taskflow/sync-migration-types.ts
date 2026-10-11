/**
 * Actio と Cc のずれを解消する移行手順 (spec/faq/actio-cc-task-project-sync.md §5、M1〜M6) の入力。
 * どの手順も読み取った値から計画 (一覧) を作るだけの純関数で、書き込みは別の apply が行う。
 */
export type ActioTaskStatus = "open" | "in_progress" | "blocked" | "done" | "cancelled";

/** Actio `GET /api/tasks?scope=all` の 1 件 (移行に使う項目だけ)。 */
export interface MigrationActioTask {
  id: string;
  title: string;
  description: string | null;
  projectId: string | null;
  teamId: string | null;
  status: ActioTaskStatus;
  source: string | null;
  category?: string | null;
  pluginPayload?: Record<string, unknown> | null;
  createdAt: string;
}

/** Cc `GET /v1/project-codes/admin` の 1 件。 */
export interface MigrationProject {
  code: string;
  project: string;
  teams: string[];
  renamed_from: string[];
}

/** Cc taskflow_task_state の 1 行。 */
export interface MigrationStateRow {
  repo_path: string;
  task_path: string;
  status: string;
  actio_task_id: string | null;
  delegation_run_id: string | null;
}

/** Cc delegation_runs のうち task に結びついたもの。 */
export interface MigrationRun {
  id: string;
  reference: string | null;
  branch: string | null;
  createdAt: number;
}

export const V3_SOURCE = "concordia.taskflow.v3";
export const OPEN_STATUSES: ReadonlySet<ActioTaskStatus> = new Set(["open", "in_progress", "blocked"]);

export function isOpenTask(task: Pick<MigrationActioTask, "status">): boolean {
  return OPEN_STATUSES.has(task.status);
}
