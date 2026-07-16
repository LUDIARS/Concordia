import type { CostTimestampFormat } from "../cost/cost-report.js";
import type { OAuthUsage } from "../auth/anthropic-oauth-usage.js";
import type { ProjectSufficiency } from "../harness/data-sufficiency.js";

export type ChatPlatformName = "discord" | "slack";

export interface ChatMessageMetadata {
  source?: string;
  discord_user_id?: string;
  discord_message_id?: string;
  discord_channel_id?: string;
  slack_user_id?: string;
  scope?: string;
  attachment_paths?: string[];
}

export interface ChatMessageRelay {
  id: number;
  channel: string;
  sessionId: string | null;
  authorLabel: string;
  text: string;
  metadata: ChatMessageMetadata;
}

export interface SessionRelayState {
  sessionId: string;
  provider: string;
  repoPath: string;
  branch: string | null;
  status: string;
  currentTask: string | null;
  roleLabel: string | null;
  personaId: string | null;
  personaDisplayName: string | null;
  personaName: string | null;
  delegationEmoji: string | null;
  delegationRunId: string | null;
  delegationParentSessionId: string | null;
  model: string | null;
  effortLevel: string | null;
  fastMode: boolean | null;
  subsidiaryId: string | null;
}

export interface SessionCardState {
  who: string;
  emoji: string | null;
  provider: string | null;
  model: string | null;
  currentTask: string | null;
  shortId: string;
  status: "active" | "ended";
  poem: string | null;
}

export interface SessionPromptRelayEvent {
  sessionId: string;
  provider: string;
  status: string;
  text: string;
  source: string;
}

export interface SessionTitleRelayEvent {
  sessionId: string;
  provider: string;
  status: string;
  title: string;
  source: string | null;
}

export interface SessionStatusTask {
  active_form: string | null;
  task_text: string;
}

export interface SessionCacheSnapshot {
  gets: number;
  hits: number;
  hitRate: number;
  basis: "observed" | "measured" | "assumed";
  savedUsd: number;
  spentUsd: number;
}

export interface SessionStatusSnapshot {
  sessionId: string;
  provider: string;
  model: string | null;
  effortLevel: string | null;
  fastMode: boolean | null;
  branch: string | null;
  repoPath: string;
  targetProject: string | null;
  currentTask: string | null;
  status: string;
  ageSec: number | null;
  personaText: string;
  sessionChannelId: string;
  inProgress: SessionStatusTask[];
  pending: Array<{ task_text: string }>;
  doneCount: number;
  concordiaPending: number;
  cache: SessionCacheSnapshot | null;
  sufficiency: ProjectSufficiency | null;
  contextBadge: string;
  contextPct: number | null;
  costBadge: string;
  goalBadge: string;
  contextWarningRequesterUserId: string | null;
}

export interface MonitorSnapshot {
  generatedAt: number;
  activeCount: number;
  orgCostLines: string[];
  channelCostLines: string[];
}

export interface PrQueueSnapshot {
  content: string;
}

export interface CostRateSnapshot {
  used5h: number | null;
  reset5hAt: number | null;
}

export interface CostSnapshot {
  markdown: string;
  codexRate: CostRateSnapshot;
  claudeUsage: OAuthUsage | null;
}

export interface WorkflowTargetSnapshot {
  id: number;
  text: string;
  authorLabel: string;
  sessionId: string | null;
  repoPath: string | null;
  sessionActive: boolean;
}

export interface MonitorSnapshotOptions {
  subsidiaryId?: string | null;
  costSubsidiaries?: Array<{ id: string; name: string; daily_token_budget: number }>;
  channelForSession(sessionId: string): string | null;
}

export interface PrQueueSnapshotOptions {
  channelForSession(sessionId: string): string | null;
}

export interface ChatReadModel {
  getChatMessage(messageId: number): ChatMessageRelay | null;
  getWorkflowTarget(chatId: number): WorkflowTargetSnapshot | null;
  getLatestWorkflowTargetForSession(sessionId: string): WorkflowTargetSnapshot | null;
  getLatestWorkflowTargetForChannel(channel: string): WorkflowTargetSnapshot | null;
  getSessionRelayState(sessionId: string): SessionRelayState | null;
  getSessionCardState(sessionId: string, status: "active" | "ended", poem?: string | null): SessionCardState | null;
  getEndedSessionPoem(sessionId: string): string | null;
  getSessionStatusSnapshot(sessionId: string, sessionChannelId: string): Promise<SessionStatusSnapshot | null>;
  getSessionPromptEvent(sessionId: string): SessionPromptRelayEvent | null;
  getSessionTitleEvent(sessionId: string): SessionTitleRelayEvent | null;
  getMonitorSnapshot(options: MonitorSnapshotOptions): MonitorSnapshot;
  getPrQueueSnapshot(options: PrQueueSnapshotOptions): PrQueueSnapshot;
  getCostSnapshot(format: CostTimestampFormat, nowSec: number): Promise<CostSnapshot>;
  isSessionActive(sessionId: string): boolean;
  isCodexSession(sessionId: string): boolean;
}
