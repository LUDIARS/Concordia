import type { ChatRepo, ChatMessageRow } from "../db/chat-repo.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { SessionTaskRecordsRepo } from "../db/session-task-records-repo.js";
import type { TasksRepo } from "../db/tasks-repo.js";
import type { PrRecordsRepo } from "../db/pr-records-repo.js";
import type { DelegationRepo } from "../db/delegation-repo.js";
import { estimateContextTokens, formatContextBadge } from "../cost/context-estimate.js";
import { estimateSessionCostUsd, formatCostBadge } from "../cost/session-cost.js";
import { collectOrgCostWindows, renderOrgCostLines, type OrgCostSubsidiary } from "../cost/org-cost.js";
import { cachedSessionWindowReader } from "../cost/windowed-usage-cache.js";
import { cachedChannelCostReader } from "../cost/channel-cost-cache.js";
import { collectChannelCostRows, renderChannelCostLines } from "../cost/channel-cost.js";
import { collectCostReport, renderCostReportMarkdown, type CostTimestampFormat } from "../cost/cost-report.js";
import { readGoalFromMetadata, formatGoalBadge } from "../control/goal.js";
import { lastHumanRequester } from "../control/requester.js";
import { fetchSessionCacheStats } from "../anatomia/cache-stats-client.js";
import { probeProjectSufficiency } from "../harness/data-sufficiency.js";
import { formatAuthorName } from "../platform/formatter.js";
import { buildPrQueue } from "../pr/queue.js";
import { renderPrQueueMarkdown } from "../pr/render.js";
import type { ChatReadModel, ChatMessageMetadata, ChatMessageRelay, CostSnapshot, MonitorSnapshot, PrQueueSnapshot, SessionCardState, SessionRelayState, SessionStatusSnapshot, SlackSessionIndexEntry, WorkflowTargetSnapshot } from "../platform/chat-read-model.js";

const PR_QUEUE_CONTENT_LIMIT = 2000;

export interface ChatReadModelDeps {
  chatRepo: ChatRepo;
  sessionsRepo: SessionsRepo;
  sessionTaskRecordsRepo: SessionTaskRecordsRepo;
  tasksRepo: TasksRepo;
  prRecordsRepo: PrRecordsRepo;
  delegationRepo: DelegationRepo;
  oauthLog?: { warn: (m: string) => void; info?: (m: string) => void };
  perfLog?: { warn: (m: string) => void; info?: (m: string) => void };
  costSnapshotAllowFullScan?: boolean;
  hasPendingQuestion?: (sessionId: string) => boolean;
}

export function makeChatReadModel(deps: ChatReadModelDeps): ChatReadModel {
  const relayState = (sessionId: string): SessionRelayState | null => {
    const session = deps.sessionsRepo.findSession(sessionId);
    if (!session) return null;
    const meta = readSessionMeta(session.metadata);
    const delegationRunId = stringOrNull(meta.delegation_run_id);
    const delegationRun = delegationRunId ? deps.delegationRepo.findRun(delegationRunId) : null;
    return {
      sessionId,
      provider: session.provider,
      repoPath: session.repo_path,
      branch: session.branch ?? delegationRun?.spawn_branch ?? null,
      status: session.status,
      currentTask: session.current_task,
      roleLabel: stringOrNull(meta.role_label),
      delegationEmoji: stringOrNull(meta.delegation_emoji),
      delegationRunId,
      delegationParentSessionId: stringOrNull(meta.delegation_parent_session_id),
      model: delegationRun?.effective_model ?? stringOrNull(meta.model),
      effortLevel: delegationRun?.effort_level ?? stringOrNull(meta.effort),
      fastMode: delegationRun ? delegationRun.fast_mode === 1 : booleanOrNull(meta.fast_mode),
      subsidiaryId: stringOrNull(meta.subsidiary_id),
    };
  };

  const workflowTarget = (row: ChatMessageRow | null): WorkflowTargetSnapshot | null => {
    if (!row) return null;
    let repoPath: string | null = null;
    let sessionActive = false;
    if (row.session_id) {
      const session = deps.sessionsRepo.findSession(row.session_id);
      repoPath = session?.repo_path ?? null;
      sessionActive = session?.status === "active";
    }
    return {
      id: row.id,
      text: row.text,
      authorLabel: row.author_label,
      sessionId: row.session_id,
      repoPath,
      sessionActive,
    };
  };

  return {
    getChatMessage(messageId) {
      return toChatRelay(deps.chatRepo.findById(messageId));
    },
    getWorkflowTarget(chatId) {
      return workflowTarget(deps.chatRepo.findById(chatId));
    },
    getLatestWorkflowTargetForSession(sessionId) {
      return workflowTarget(deps.chatRepo.latestForSession(sessionId));
    },
    getLatestWorkflowTargetForChannel(channel) {
      return workflowTarget(deps.chatRepo.list({ channel: channel as never, limit: 1 })[0] ?? null);
    },
    getSessionRelayState: relayState,
    getSessionCardState(sessionId, status, poem) {
      const state = relayState(sessionId);
      if (!state) return null;
      return {
        who: formatAuthorName(null, state.roleLabel),
        emoji: state.delegationEmoji,
        provider: state.provider,
        model: state.model,
        currentTask: state.currentTask,
        shortId: sessionId.slice(0, 8),
        status,
        poem: poem ?? null,
      } satisfies SessionCardState;
    },
    getEndedSessionPoem(sessionId) {
      const report = deps.sessionsRepo.findReport(sessionId);
      return extractMonologue(report?.summary_md);
    },
    listSlackSessionIndex() {
      return deps.sessionsRepo.listSessions({}).map((session) => {
        const state = relayState(session.id);
        return {
          sessionId: session.id,
          provider: session.provider,
          status: session.status,
          currentTask: session.current_task,
          roleLabel: state?.roleLabel ?? null,
          updatedAt: session.last_seen_at,
          waiting: deps.hasPendingQuestion?.(session.id) ?? false,
        } satisfies SlackSessionIndexEntry;
      });
    },
    async getSessionStatusSnapshot(sessionId, sessionChannelId) {
      const session = deps.sessionsRepo.findSession(sessionId);
      if (!session) return null;
      const state = relayState(sessionId);
      if (!state) return null;
      const taskRows = deps.sessionTaskRecordsRepo.listBySession(sessionId);
      const openTasks = taskRows.filter((t) => t.status !== "completed");
      const recent = deps.sessionsRepo.recentEvents(sessionId, 1);
      const lastEventTsSec = recent.length > 0 ? recent[0].ts : null;
      const ageSec = lastEventTsSec === null ? null : Math.floor(Date.now() / 1000) - lastEventTsSec;
      const cache = await fetchSessionCacheStats(sessionId).catch(() => null);
      const sufficiency = await probeProjectSufficiency(session.target_project ?? session.repo_path).catch(() => null);
      const ctx = await estimateContextTokens(session);
      const cost = await estimateSessionCostUsd(session);
      const requester = lastHumanRequester(deps.sessionsRepo.recentEvents(sessionId, 100));
      return {
        sessionId,
        provider: session.provider,
        model: state.model,
        effortLevel: state.effortLevel,
        fastMode: state.fastMode,
        branch: state.branch,
        repoPath: session.repo_path,
        targetProject: session.target_project,
        currentTask: session.current_task,
        status: session.status,
        ageSec,
        roleLabel: state.roleLabel,
        sessionChannelId,
        inProgress: openTasks
          .filter((t) => t.status === "in_progress")
          .map((t) => ({ active_form: t.active_form, task_text: t.task_text })),
        pending: openTasks
          .filter((t) => t.status === "pending")
          .map((t) => ({ task_text: t.task_text })),
        doneCount: taskRows.filter((t) => t.status === "completed").length,
        concordiaPending: deps.tasksRepo.countUndeliveredForSession(sessionId),
        cache,
        sufficiency,
        contextBadge: formatContextBadge(ctx),
        contextPct: ctx?.pct ?? null,
        costBadge: formatCostBadge(cost),
        goalBadge: formatGoalBadge(readGoalFromMetadata(session.metadata)),
        contextWarningRequesterUserId: requester?.platform === "discord" ? requester.userId : null,
      } satisfies SessionStatusSnapshot;
    },
    getSessionPromptEvent(sessionId) {
      const state = relayState(sessionId);
      if (!state) return null;
      const latest = deps.sessionsRepo.recentEvents(sessionId, 1)[0];
      const payload = readObject(latest?.payload);
      const text = typeof payload.summary === "string" ? payload.summary.trim() : "";
      const source = typeof payload.source === "string" ? payload.source : "";
      if (!text) return null;
      return { sessionId, provider: state.provider, status: state.status, text, source };
    },
    getSessionTitleEvent(sessionId) {
      const state = relayState(sessionId);
      if (!state) return null;
      const latest = deps.sessionsRepo.recentEvents(sessionId, 1)[0];
      const payload = readObject(latest?.payload);
      const title = typeof payload.text === "string" ? payload.text : "";
      const source = typeof payload.source === "string" ? payload.source : null;
      if (!title) return null;
      return { sessionId, provider: state.provider, status: state.status, title, source };
    },
    async getMonitorSnapshot(options) {
      const active = deps.sessionsRepo
        .listSessions({ status: "active" })
        .filter((session) => sessionOwnedBy(session.metadata, options.subsidiaryId ?? null));
      const orgCostLines = options.costSubsidiaries
        ? renderOrgCostLines(await collectOrgCostWindows(
          deps.sessionsRepo,
          options.costSubsidiaries as OrgCostSubsidiary[],
          Date.now(),
          cachedSessionWindowReader,
        ))
        : [];
      const channelRows = await collectChannelCostRows(active, options.channelForSession, cachedChannelCostReader);
      return {
        generatedAt: Math.floor(Date.now() / 1000),
        activeCount: active.length,
        orgCostLines,
        channelCostLines: renderChannelCostLines(channelRows),
      } satisfies MonitorSnapshot;
    },
    getPrQueueSnapshot(options) {
      const queue = buildPrQueue(deps.prRecordsRepo);
      const body = renderPrQueueMarkdown(queue, {
        mentionFor: (row) => row.author_session_id ? mentionFor(options.channelForSession(row.author_session_id)) : null,
      });
      return { content: truncateForDiscord(body) } satisfies PrQueueSnapshot;
    },
    async getCostSnapshot(format: CostTimestampFormat, nowSec: number): Promise<CostSnapshot> {
      const report = await collectCostReport(deps.sessionsRepo, {
        oauthLog: deps.oauthLog,
        perfLog: deps.perfLog ?? deps.oauthLog,
        allowFullScan: deps.costSnapshotAllowFullScan,
      });
      return {
        markdown: renderCostReportMarkdown(report, format, nowSec),
        codexRate: {
          used5h: report.codexRate.used5h,
          reset5hAt: report.codexRate.reset5hAt,
        },
        claudeUsage: report.claudeUsage,
      };
    },
    isSessionActive(sessionId) {
      return relayState(sessionId)?.status === "active";
    },
    isCodexSession(sessionId) {
      return relayState(sessionId)?.provider === "codex-cli";
    },
  };
}

function toChatRelay(row: ChatMessageRow | null): ChatMessageRelay | null {
  if (!row) return null;
  return {
    id: row.id,
    channel: row.channel,
    sessionId: row.session_id,
    authorLabel: row.author_label,
    text: row.text,
    metadata: readChatMeta(row.metadata),
  };
}

function readSessionMeta(raw: string | null | undefined): Record<string, unknown> {
  return readObject(raw);
}

function readChatMeta(raw: string | null | undefined): ChatMessageMetadata {
  const parsed = readObject(raw);
  const attachmentPaths = Array.isArray(parsed.attachment_paths)
    ? parsed.attachment_paths.filter((v): v is string => typeof v === "string")
    : undefined;
  return {
    source: stringOrUndefined(parsed.source),
    discord_user_id: stringOrUndefined(parsed.discord_user_id),
    discord_message_id: stringOrUndefined(parsed.discord_message_id),
    discord_channel_id: stringOrUndefined(parsed.discord_channel_id),
    slack_user_id: stringOrUndefined(parsed.slack_user_id),
    scope: stringOrUndefined(parsed.scope),
    ...(attachmentPaths ? { attachment_paths: attachmentPaths } : {}),
  };
}

function readObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return {};
  }
  return {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function sessionOwnedBy(metadata: string | null, subsidiaryId: string | null): boolean {
  const sid = stringOrNull(readSessionMeta(metadata).subsidiary_id);
  return subsidiaryId ? sid === subsidiaryId : !sid;
}

function mentionFor(channelId: string | null): string | null {
  return channelId ? `<#${channelId}>` : null;
}

function truncateForDiscord(text: string, limit = PR_QUEUE_CONTENT_LIMIT): string {
  if (text.length <= limit) return text;
  const marker = "\n...(truncated)";
  const budget = limit - marker.length;
  const head = text.slice(0, budget);
  const lastNl = head.lastIndexOf("\n");
  const body = lastNl > budget * 0.5 ? head.slice(0, lastNl) : head;
  return body + marker;
}

function extractMonologue(summaryMd: string | null | undefined): string | null {
  if (!summaryMd) return null;
  const lines = summaryMd
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  return lines.slice(0, 4).join("\n").slice(0, 800);
}
