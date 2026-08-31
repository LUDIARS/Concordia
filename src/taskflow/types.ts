export type TaskStatus = "pending" | "delegated" | "done" | "cancelled";

export function isTaskStatus(value: unknown): value is TaskStatus {
  return value === "pending" || value === "delegated" || value === "done" || value === "cancelled";
}

export interface TaskFrontmatter {
  task: string;
  project: string;
  kind: string;
  created: string;
  memory_links?: string[];
  [key: string]: unknown;
}

export interface TaskRuntimeState {
  status: TaskStatus;
  /** タスクを作成・管理する子会社。 null = 本社。 */
  subsidiary_id: string | null;
  source_session: string | null;
  assignee: string | null;
  owner: string | null;
  delegation_run_id: string | null;
  pr_number: number | null;
  memoria_task_id: string | null;
  actio_task_id: string | null;
  memoria_registration_state: "idle" | "creating" | "created";
}

export interface TaskDocument {
  path: string;
  repoPath: string;
  title: string;
  frontmatter: TaskFrontmatter;
  body: string;
  runtime?: TaskRuntimeState;
}
