import type { SessionsRepo } from "../../db/sessions-repo.js";
import type { ParticipantsRepo } from "../../db/participants-repo.js";
import type { HarnessAuditRepo } from "../../db/harness-audit-repo.js";
import type { TasksRepo } from "../../db/tasks-repo.js";
import type { ChatRepo } from "../../db/chat-repo.js";
import type { ConcordiaConfig } from "../../shared/config.js";
import type { PersonasRepo } from "../../db/personas-repo.js";
import type { ProcessManager } from "../../processes/manager.js";
import type { SessionTaskRecordsRepo } from "../../db/session-task-records-repo.js";
import type { TranscriptLogsRepo } from "../../db/transcript-logs-repo.js";
import type { DelegationRepo } from "../../db/delegation-repo.js";

export type ChannelDirectoryMetaKind = "chitchat" | "consultation" | "houkoku" | "system";

export interface ChannelDirectorySessionChannel {
  channel_id: string;
  status: string;
}

export interface ChannelDirectoryQuestionOption {
  label: string;
  description?: string;
}

export interface ChannelDirectoryQuestionRow {
  id: number;
  session_id: string;
  question: string;
  options: ChannelDirectoryQuestionOption[];
  answered_at: number | null;
  ts: number;
}

export interface ChannelDirectory {
  findSessionChannel(sessionId: string): ChannelDirectorySessionChannel | null;
  listMetaChannels(): Record<ChannelDirectoryMetaKind, string | null>;
  insert(input: {
    session_id: string;
    question: string;
    options: Array<ChannelDirectoryQuestionOption | string>;
    multiSelect?: boolean;
  }): ChannelDirectoryQuestionRow;
  findById(id: number): ChannelDirectoryQuestionRow | null;
  findUnansweredByQuestion(sessionId: string, question: string): ChannelDirectoryQuestionRow | null;
  findRecentlyAnsweredByQuestion(sessionId: string, question: string, sinceTs: number): ChannelDirectoryQuestionRow | null;
  markAnswered(id: number, answerIndex: number, answerText: string): void;
  markAnsweredMulti(id: number, answerIndices: number[], answerText: string): void;
  markAnsweredOther(id: number, answerText: string): void;
  markResolvedLocally(id: number): void;
}

export interface SessionsApiDeps {
  repo: SessionsRepo;
  tasks: TasksRepo;
  chat: ChatRepo;
  config: ConcordiaConfig;
  personas: PersonasRepo;
  processManager: ProcessManager;
  sessionTaskRecords: SessionTaskRecordsRepo;
  transcriptLogs: TranscriptLogsRepo;
  delegation?: DelegationRepo;
  channelDirectory: ChannelDirectory;
  participants: ParticipantsRepo;
  resolveWorkspaceRoots?: () => string[];
  resolvePersonaInjectEnabled?: () => boolean;
  resolveCcWorkflowEnabled?: () => boolean;
  /** session-end ??????????????????????????????????????? (??????*/
  harnessAudit?: HarnessAuditRepo;
}
