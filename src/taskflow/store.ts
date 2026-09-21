import type { TaskDocument, TaskStatus } from "./types.js";

export interface RemainingTasksInput {
  repoPath: string; sourceRunId: string; project: string;
  subsidiaryId?: string | null;
  remaining: ReadonlyArray<{ title: string; note?: string; scope_dirs?: string[] }>;
}

export interface TaskCreateInput {
  repoPath: string; subsidiaryId: string | null; sourceRef: string;
  title: string; body: string; kind: string; memoryLinks: string[];
  status?: TaskStatus;
  dueAt?: string | null;
}

/** The runtime depends on task retrieval, never on a filesystem backend. */
export interface TaskStore {
  scan(): Promise<TaskDocument[]>;
  findForProject(project: string, statuses?: readonly TaskStatus[], subsidiaryId?: string | null): Promise<TaskDocument[]>;
  findByRelativePath(repoPath: string, reference: string): Promise<{ status: string } | null>;
  relativePath(document: TaskDocument): string;
  writeRemainingTasks(input: RemainingTasksInput): Promise<{ created: string[]; existed: string[] }>;
  create?(input: TaskCreateInput): Promise<TaskDocument>;
  read?(repoPath: string, reference: string, subsidiaryId: string | null): Promise<TaskDocument>;
  updateStatus?(repoPath: string, reference: string, status: TaskStatus, subsidiaryId: string | null): Promise<void>;
  associate?(document: TaskDocument, runId: string, sessionId: string | null): void;
  releaseExecution?(runId: string): void;
}
