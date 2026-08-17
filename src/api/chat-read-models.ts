import type { ChatRepo, ChatMessageRow } from "../db/chat-repo.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { SessionTaskRecordsRepo } from "../db/session-task-records-repo.js";
import type { TasksRepo } from "../db/tasks-repo.js";
import type { PrRecordsRepo } from "../db/pr-records-repo.js";
import type { DelegationRepo } from "../db/delegation-repo.js";
import type { TranscriptLogsRepo } from "../db/transcript-logs-repo.js";
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
import { projectDelegatedChildRun } from "../delegation/status-card-projection.js";
import type { ChatReadModel, ChatMessageMetadata, ChatMessageRelay, CostSnapshot, MonitorSnapshot, PrQueueSnapshot, SessionCardState, SessionRelayState, SessionStatusSnapshot, SlackSessionIndexEntry, WorkflowTargetSnapshot } from "../platform/chat-read-model.js";

const PR_QUEUE_CONTENT_LIMIT = 2000;

export interface ChatReadModelDeps {
  chatRepo: ChatRepo;
  sessionsRepo: SessionsRepo;
  sessionTaskRecordsRepo: SessionTaskRecordsRepo;
  tasksRepo: TasksRepo;
  prRecordsRepo: PrRecordsRepo;
  delegationRepo: DelegationRepo;
  /**
   * codex-sdk は JSONL ではなく transcript frame に usage を残すため、状態カードも
   * 同じ一次ソースを読む。cost 層を型依存に巻き込まないよう DB repo の最小面を使う。
   */
  usageFrames: Pick<TranscriptLogsRepo, "listUsagePayloads">;
  oauthLog?: { warn: (m: string) => void; info?: (m: string) => void };
  perfLog?: { warn: (m: string) => void; info?: (m: string) => void };
  costSnapshotAllowFullScan?: boolean;
  hasPendingQuestion?: (sessionId: string) => boolean;
}

export function makeChatReadModel(deps: ChatReadModelDeps): ChatReadModel {
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
    getSessionRelayState(sessionId) {
      return readSessionRelay(sessionId, deps.sessionsRepo, deps.delegationRepo);
    },
    getSessionCardState(sessionId, status, poem) {
      const state = readSessionRelay(sessionId, deps.sessionsRepo, deps.delegationRepo);
      if (!state) return null;
      return {
        who: formatAuthorName(null, state.roleLabel),
        emoji: state.delegationEmoji,
        provider: state.provider,
        model: state.model,
        effortLevel: state.effortLevel,
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
        const state = readSessionRelay(session.id, deps.sessionsRepo, deps.delegationRepo);
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
      const state = readSessionRelay(sessionId, deps.sessionsRepo, deps.delegationRepo);
      if (!state) return null;
      const taskRows = deps.sessionTaskRecordsRepo.listBySession(sessionId);
      const openTasks = taskRows.filter((t) => t.status !== "completed");
      const recent = deps.sessionsRepo.recentEvents(sessionId, 1);
      const lastEventTsSec = recent.length > 0 ? recent[0].ts : null;
      const ageSec = lastEventTsSec === null ? null : Math.floor(Date.now() / 1000) - lastEventTsSec;
      const cache = await fetchSessionCacheStats(sessionId).catch(() => null);
      const sufficiency = await probeProjectSufficiency(session.target_project ?? session.repo_path).catch(() => null);
      const ctx = await estimateContextTokens(session);
      const cost = await estimateSessionCostUsd(session, deps.usageFrames);
      const requester = lastHumanRequester(deps.sessionsRepo.recentEvents(sessionId, 100));
      return {
        sessionId,
        provider: session.provider,
        model: state.model,
        effortLevel: state.effortLevel,
        fastMode: state.fastMode,
        branch: state.branch,
        repoPath: state.repoPath,
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
        delegatedChildren: deps.delegationRepo
          .listRunsByParentSession(sessionId, 8)
          .map(projectDelegatedChildRun),
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
      const state = readSessionRelay(sessionId, deps.sessionsRepo, deps.delegationRepo);
      if (!state) return null;
      const latest = deps.sessionsRepo.recentEvents(sessionId, 1)[0];
      const payload = readObject(latest?.payload);
      const text = typeof payload.summary === "string" ? payload.summary.trim() : "";
      const source = typeof payload.source === "string" ? payload.source : "";
      if (!text) return null;
      return { sessionId, provider: state.provider, status: state.status, text, source };
    },
    getSessionTitleEvent(sessionId) {
      const state = readSessionRelay(sessionId, deps.sessionsRepo, deps.delegationRepo);
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
      return readSessionRelay(sessionId, deps.sessionsRepo, deps.delegationRepo)?.status === "active";
    },
    isCodexSession(sessionId) {
      return readSessionRelay(sessionId, deps.sessionsRepo, deps.delegationRepo)?.provider === "codex-cli";
    },
  };
}

/**
 * セッション表示に必要な値を DB から投影する。factory のクロージャに閉じ込めず、
 * 依存を引数として明示して各 read model 操作の参照境界を一定に保つ。
 */
function readSessionRelay(
  sessionId: string,
  sessionsRepo: SessionsRepo,
  delegationRepo: DelegationRepo,
): SessionRelayState | null {
  const session = sessionsRepo.findSession(sessionId);
  if (!session) return null;
  const meta = readSessionMeta(session.metadata);
  const delegationRunId = stringOrNull(meta.delegation_run_id);
  const delegationRun = delegationRunId ? delegationRepo.findRun(delegationRunId) : null;
  const workingRepoPath = session.target_project ?? session.repo_path;
  return {
    sessionId,
    provider: session.provider,
    repoPath: workingRepoPath,
    activeRepos: readActiveRepos(session.active_repos, workingRepoPath),
    targetProject: session.target_project,
    branch: session.branch ?? delegationRun?.spawn_branch ?? null,
    status: session.status,
    currentTask: session.current_task,
    roleLabel: stringOrNull(meta.role_label),
    delegationEmoji: stringOrNull(meta.delegation_emoji),
    delegationRunId,
    delegationParentSessionId: stringOrNull(meta.delegation_parent_session_id),
    // Runtime model review records the current setting in session metadata. It
    // must override the immutable launch-time delegation run so status cards do
    // not keep showing the value that was replaced after a task change.
    model: stringOrNull(meta.model) ?? delegationRun?.effective_model ?? null,
    effortLevel: stringOrNull(meta.effort) ?? delegationRun?.effort_level ?? null,
    fastMode: delegationRun ? delegationRun.fast_mode === 1 : booleanOrNull(meta.fast_mode),
    subsidiaryId: stringOrNull(meta.subsidiary_id),
    requesterDiscordUserId: stringOrNull(meta.discord_requester_user_id),
    startupInjectText: stringOrNull(meta.discord_startup_inject),
    startupContextPosted: meta.discord_startup_context_posted === true,
    startupTaskText: stringOrNull(meta.discord_startup_task),
    taskPosted: meta.discord_task_posted === true,
    taskPinned: meta.discord_task_pinned === true,
    stagedInjection: delegationRun ? delegationRun.staged_injection === 1 : false,
    stagedFollowupDelivered: delegationRun ? delegationRun.staged_followup_at != null : false,
    sourceDiscordGuildId: stringOrNull(meta.discord_source_guild_id),
    sourceDiscordChannelId: stringOrNull(meta.discord_source_channel_id),
    endedAt: session.ended_at ?? null,
    webhookName: stringOrNull(meta.discord_webhook_name),
    webhookAvatarUrl: stringOrNull(meta.discord_webhook_avatar_url),
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
    webhook_username: stringOrUndefined(parsed.webhook_username),
    webhook_avatar_url: stringOrUndefined(parsed.webhook_avatar_url),
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

function readActiveRepos(raw: string | undefined, fallback: string): string[] {
  try {
    const parsed = JSON.parse(raw ?? "[]") as unknown;
    const repos = Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string" && value.trim() !== "") : [];
    return repos.length > 0 ? repos : [fallback];
  } catch {
    return [fallback];
  }
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
