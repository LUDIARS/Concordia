import type { DepartmentStartupInject } from "../../departments/settings.js";
import type { SessionsRepo } from "../../db/sessions-repo.js";
import type { ParticipantsRepo } from "../../db/participants-repo.js";
import type { HarnessAuditRepo } from "../../db/harness-audit-repo.js";
import type { TasksRepo } from "../../db/tasks-repo.js";
import type { EscalationRepo } from "../../db/escalation-repo.js";
import type { ChatRepo } from "../../db/chat-repo.js";
import type { ConcordiaConfig } from "../../shared/config.js";
import type { ProcessManager } from "../../processes/manager.js";
import type { SessionTaskRecordsRepo } from "../../db/session-task-records-repo.js";
import type { TranscriptLogsRepo } from "../../db/transcript-logs-repo.js";
import type { DelegationRepo } from "../../db/delegation-repo.js";
import type { ControlJobsRepo } from "../../db/control-jobs-repo.js";
import type { SessionMessagesRepo } from "../../db/session-messages-repo.js";
import type { SessionMessageReadsRepo } from "../../db/session-message-reads-repo.js";
import type { ConcordiaEvent } from "../../events.js";
import type { ProjectCodesRepo } from "../../db/project-codes-repo.js";
import type { MajorInjectResolver } from "../../control/major-inject-resolver.js";
import type { TaskStore } from "../../taskflow/store.js";
import type { ContextLinks } from "../../control/inject-context-links.js";

export type ChannelDirectoryMetaKind = "chitchat" | "consultation" | "houkoku" | "system" | "genius";

export interface ChannelDirectorySessionChannel {
  channel_id: string;
  status: string;
}

export interface ChannelDirectoryQuestionOption {
  label: string;
  description?: string;
}

export interface ChannelDirectoryQuestionRow {
  kind?: "question" | "plan_approval";
  provider_request_id?: string | null;
  closed_at?: number | null;
  id: number;
  session_id: string;
  question: string;
  options: ChannelDirectoryQuestionOption[];
  answered_at: number | null;
  /** 回答済みなら確定した選択肢 index (自由文は null)。 */
  answer_index: number | null;
  /** 回答済みなら確定した回答本文。 */
  answer_text: string | null;
  /** 委託子の質問を一次受けした親。 非 null = 人間へはまだ配信していない。 */
  parent_session_id: string | null;
  /** 人間へ上げた時刻。 null = まだ親だけが持っている。 */
  escalated_at: number | null;
  /** 複数選択の質問か。 エスカレーション時に元の回答形式を保つのに要る。 */
  multi_select: boolean;
  ts: number;
}

export interface ChannelDirectory {
  findSessionChannel(sessionId: string): ChannelDirectorySessionChannel | null;
  listMetaChannels(): Record<ChannelDirectoryMetaKind, string | null>;
  insert(input: {
    kind?: "question" | "plan_approval";
    providerRequestId?: string;
    session_id: string;
    question: string;
    options: Array<ChannelDirectoryQuestionOption | string>;
    multiSelect?: boolean;
    /** 委託子の質問なら親 (委託元) の session id。 人間へは配信しない印。 */
    parentSessionId?: string | null;
  }): ChannelDirectoryQuestionRow;
  /** 親が裁けない質問を人間へ上げる。 未回答かつ未エスカレーションのときだけ true。 */
  markEscalated(id: number): boolean;
  /** 親へ預けたまま放置されている質問 (未回答 / 未エスカレーション)。 */
  listStaleParentRelayed(olderThanTs: number, limit: number): ChannelDirectoryQuestionRow[];
  findById(id: number): ChannelDirectoryQuestionRow | null;
  findByProviderRequest(sessionId: string, requestId: string): ChannelDirectoryQuestionRow | null;
  findUnansweredByQuestion(sessionId: string, question: string): ChannelDirectoryQuestionRow | null;
  findRecentlyAnsweredByQuestion(sessionId: string, question: string, sinceTs: number): ChannelDirectoryQuestionRow | null;
  markAnswered(id: number, answerIndex: number, answerText: string): void;
  markAnsweredMulti(id: number, answerIndices: number[], answerText: string): void;
  markAnsweredOther(id: number, answerText: string): void;
  markResolvedLocally(id: number): void;
}

export interface SessionsApiDeps {
  resolveContextLinks?: (repoPath: string, repoOrigin: string | null) => Promise<ContextLinks>;
  taskStore?: () => TaskStore;
  majorInject?: MajorInjectResolver;
  resolveProjectStartupWorkflow?: (repoPath: string, repoOrigin: string | null) => Promise<import("../../control/project-startup-workflow.js").ProjectStartupWorkflow>;
  repo: SessionsRepo;
  tasks: TasksRepo;
  /** エスカレーションモードの状態 + 監査 (spec/feature/escalation-mode.md)。 */
  escalations: EscalationRepo;
  chat: ChatRepo;
  config: ConcordiaConfig;
  processManager: ProcessManager;
  sessionTaskRecords: SessionTaskRecordsRepo;
  transcriptLogs: TranscriptLogsRepo;
  delegation?: DelegationRepo;
  controlJobs: ControlJobsRepo;
  channelDirectory: ChannelDirectory;
  /** spawn で紐付いた Memoria タスクを正常終了時に完了させる口 (spec/feature/teams.md §2)。 */
  memoria?: { completeTask?(id: number): Promise<void> };
  participants: ParticipantsRepo;
  sessionMessages: SessionMessagesRepo;
  sessionMessageReads: SessionMessageReadsRepo;
  projectSessionEvent: (event: ConcordiaEvent) => void;
  /** Cc 所有の project-code 正本。未注入時は空 registry として扱う。 */
  projectCodes?: ProjectCodesRepo;
  /** thinking frame を Concordia の表示・中継面へ流すか。未注入時は OFF。 部署の出力方針で上書きされる。 */
  isThinkingEnabled?: (sessionId: string) => boolean;
  resolveWorkspaceRoots?: () => string[];
  resolveCcWorkflowEnabled?: () => boolean;
  /** 部署の起動時の注入方針 (departments.md §9.5)。 未注入・部署なしは全部送る。 */
  departmentStartupInject?: (departmentId: string) => DepartmentStartupInject;
  /** 実行中セッションへの model/effort 反映。 未注入なら Lictor へ直接切替を送る (runtime-switch)。 */
  applyModelEffort?: import("../../contract/runtime-apply.js").ApplyModelEffortFn;
  /** session-end ??????????????????????????????????????? (??????*/
  harnessAudit?: HarnessAuditRepo;
}
