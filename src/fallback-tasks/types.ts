/** @implements spec/feature/cc-task-fallback.md */
export const CC_TASK_STATUSES = ["open", "in_progress", "blocked", "done", "cancelled"] as const;
export type CcTaskStatus = (typeof CC_TASK_STATUSES)[number];
export const CC_TASK_SYNC_STATES = ["pending", "checking", "creating", "unknown", "synced", "failed"] as const;
export type CcTaskSyncState = (typeof CC_TASK_SYNC_STATES)[number];

export interface CcTaskRow {
  id: string;
  source_key: string | null;
  title: string;
  details: string | null;
  status: CcTaskStatus;
  kind: "task" | "goal";
  creator_type: "human" | "ai";
  category: string | null;
  due_at: string | null;
  actio_task_id: string | null;
  actio_sync_state: CcTaskSyncState;
  actio_sync_error: string | null;
  created_at: number;
  updated_at: number;
}

export interface CcTaskInput {
  source_key?: string | null;
  title: string;
  details?: string | null;
  status?: CcTaskStatus;
  kind?: "task" | "goal";
  creator_type?: "human" | "ai";
  category?: string | null;
  due_at?: string | null;
}

export type CcTaskPatch = Partial<Omit<CcTaskInput, "source_key">>;
