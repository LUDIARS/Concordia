export type TaskStatus = "pending" | "delegated" | "done" | "cancelled";

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
