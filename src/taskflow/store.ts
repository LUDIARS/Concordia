import type { TaskDocument, TaskStatus } from "./types.js";
import type { TaskPrEvidence } from "./pr-evidence.js";

export interface RemainingTasksInput {
  repoPath: string; sourceRunId: string; project: string;
  issuedBySessionId?: string | null;
  subsidiaryId?: string | null;
  remaining: ReadonlyArray<{ title: string; note?: string; scope_dirs?: string[] }>;
}

export interface TaskCreateInput {
  issuedBySessionId?: string | null;
  repoPath: string; subsidiaryId: string | null; sourceRef: string;
  title: string; body: string; kind: string; memoryLinks: string[];
  status?: TaskStatus;
  dueAt?: string | null;
  /** Explicit Actio team; must be one of the project's registered teams. */
  teamId?: string | null;
  /** 委託元のテンプレート名 (pluginPayload.template)。 */
  template?: string | null;
  /** 作業単位のキー (work:...) で一致した既存 task を本文の違いを問わず再利用する。 */
  reuseExisting?: boolean;
}

/** task に結びつく委託の実行回 (run と task の多対 1)。 */
export interface TaskRunStart {
  runId: string;
  sessionId: string | null;
  /** 既存 task を続けるときに渡された新しい指示。本文へ追記する。 */
  instruction: string | null;
}

export interface TaskScanScope { project?: string }

/** The runtime depends on task retrieval, never on a filesystem backend. */
export interface TaskStore {
  nextExecutable?(repoPath: string, subsidiaryId: string | null): Promise<TaskDocument | null>;
  canContinue?(repoPath: string, reference: string, subsidiaryId: string | null, sessionId?: string): Promise<boolean>;
  setPrEvidence?(repoPath: string, reference: string, evidence: TaskPrEvidence, subsidiaryId: string | null): Promise<void>;
  scan(scope?: TaskScanScope): Promise<TaskDocument[]>;
  findForProject(project: string, statuses?: readonly TaskStatus[], subsidiaryId?: string | null): Promise<TaskDocument[]>;
  findByRelativePath(repoPath: string, reference: string): Promise<{ status: string } | null>;
  relativePath(document: TaskDocument): string;
  writeRemainingTasks(input: RemainingTasksInput): Promise<{ created: string[]; existed: string[] }>;
  create?(input: TaskCreateInput): Promise<TaskDocument>;
  read?(repoPath: string, reference: string, subsidiaryId: string | null): Promise<TaskDocument>;
  /** 指示参照の関連付け・表示専用。旧来タスクも返すが、作業・状態更新には使わない (CC-TASK-LINKED-FOLLOWUP)。 */
  readReference?(repoPath: string, reference: string, subsidiaryId: string | null): Promise<TaskDocument>;
  updateStatus?(repoPath: string, reference: string, status: TaskStatus, subsidiaryId: string | null): Promise<void>;
  setWorkingSession?(repoPath: string, reference: string, sessionId: string | null, subsidiaryId: string | null, expected?: string | null): Promise<void>;
  releaseWorkingSession?(sessionId: string): Promise<void>;
  associate?(document: TaskDocument, runId: string, sessionId: string | null): void;
  releaseExecution?(runId: string): void;
  recordRunStart?(document: TaskDocument, run: TaskRunStart): Promise<void>;
  recordRunEnd?(repoPath: string, reference: string, runId: string, reason: string, subsidiaryId: string | null): Promise<void>;
}
