import {
  ChannelType,
  type ForumChannel,
  type Guild,
  type PublicThreadChannel,
} from "discord.js";
import type { ChannelDisplayState } from "../db/discord-repo.js";
import { SESSION_STATE_TAG_NAMES, type DiscordConfigSnapshot } from "./config.js";
import {
  CONCORDIA_MANAGED_FORUM_TAG_NAME,
  concordiaManagedTagId,
} from "./forum-system-tag.js";
import { formatFastMode, formatWorkingBranch, type RuntimeMetadata } from "./runtime-metadata.js";
import type { WebhookPool } from "./webhook-pool.js";

export interface ForumSessionSurface {
  forumId: string;
  label: "Session" | "TaskWorkflow";
  delegationRunId: string | null;
}

export function resolveForumSessionSurface(
  layout: Pick<DiscordConfigSnapshot, "sessionForumId" | "taskWorkflowForumId">,
  delegationRunId: string | null | undefined,
): ForumSessionSurface {
  return delegationRunId
    ? { forumId: layout.taskWorkflowForumId, label: "TaskWorkflow", delegationRunId }
    : { forumId: layout.sessionForumId, label: "Session", delegationRunId: null };
}

export interface ForumSessionMetadata extends RuntimeMetadata {
  sessionId: string;
  repoPath: string;
  statusCardChannelId?: string | null;
  surfaceLabel?: "Session" | "TaskWorkflow";
  delegationRunId?: string | null;
}

export interface CreateForumSessionInput extends ForumSessionMetadata {
  projectCode: string;
  summary: string | null;
  fallbackLabel: string;
  delegationEmoji?: string | null;
  webhookName?: string | null;
  webhookAvatarUrl?: string | null;
}

export type ForumSessionThread = PublicThreadChannel<true>;
export interface CreatedForumSessionThread {
  thread: ForumSessionThread;
  starterMessageId: string;
  webhookId: string;
  webhookToken: string;
}

export function isForumSessionThread(
  channel: { type: ChannelType; parent?: unknown } | null | undefined,
): channel is ForumSessionThread {
  if (!channel || channel.type !== ChannelType.PublicThread) return false;
  const parent = (channel as PublicThreadChannel).parent;
  return parent?.type === ChannelType.GuildForum;
}

export async function createForumSessionThread(
  guild: Guild,
  forumId: string,
  webhooks: WebhookPool,
  input: CreateForumSessionInput,
): Promise<CreatedForumSessionThread> {
  const forum = guild.channels.cache.get(forumId);
  if (!forum || forum.type !== ChannelType.GuildForum) {
    throw new Error(`Session forum is unavailable: ${forumId || "(empty id)"}`);
  }
  const waitingTagId = forum.availableTags.find((tag) => tag.name === SESSION_STATE_TAG_NAMES.active)?.id;
  if (!waitingTagId) {
    throw new Error(`Session forum is missing required tag: ${SESSION_STATE_TAG_NAMES.active}`);
  }
  const managedTagId = concordiaManagedTagId({ availableTags: forum.availableTags });
  if (!managedTagId) {
    throw new Error(`Session forum is missing required tag: ${CONCORDIA_MANAGED_FORUM_TAG_NAME}`);
  }
  const created = await webhooks.createForumThread(forum.id, {
    content: buildForumStarterContent(guild.id, input),
    username: input.webhookName ?? input.fallbackLabel,
    ...(input.webhookAvatarUrl ? { avatarURL: input.webhookAvatarUrl } : {}),
    threadName: buildForumThreadTitle(
      input.projectCode,
      input.summary ?? input.fallbackLabel,
      input.delegationEmoji,
    ),
    appliedTags: [waitingTagId, managedTagId],
  });
  if (!created) throw new Error(`Session forum webhook create failed: ${forumId}`);
  const thread = await fetchForumSessionThread(guild, created.threadId);
  if (!thread) throw new Error(`Session forum webhook returned unavailable thread: ${created.threadId}`);
  return {
    thread,
    starterMessageId: created.messageId,
    webhookId: created.webhookId,
    webhookToken: created.webhookToken,
  };
}

export async function fetchForumSessionThread(
  guild: Guild,
  threadId: string,
): Promise<ForumSessionThread | null> {
  const cached = guild.channels.cache.get(threadId);
  if (isForumSessionThread(cached)) return cached;
  const fetched = await guild.channels.fetch(threadId);
  return isForumSessionThread(fetched) ? fetched : null;
}

export async function updateForumSessionTitle(
  thread: ForumSessionThread,
  projectCode: string,
  summary: string,
  delegationEmoji?: string | null,
): Promise<string> {
  const name = buildForumThreadTitle(projectCode, summary, delegationEmoji);
  await thread.setName(name, "Concordia session title updated");
  return name;
}

export async function updateForumSessionState(
  thread: ForumSessionThread,
  state: ChannelDisplayState,
): Promise<void> {
  const forum = thread.parent;
  if (!forum || forum.type !== ChannelType.GuildForum) {
    throw new Error(`Forum parent is unavailable for thread ${thread.id}`);
  }
  const stateTagNames = new Set<string>(Object.values(SESSION_STATE_TAG_NAMES));
  const stateTagIds = forum.availableTags
    .filter((tag) => stateTagNames.has(tag.name))
    .map((tag) => tag.id);
  const kept = thread.appliedTags.filter((id) => !stateTagIds.includes(id));

  if (state === "ended" || state === "lost") {
    await thread.edit({
      appliedTags: kept,
      archived: true,
      reason: state === "ended" ? "Concordia session ended" : "Concordia session lost",
    });
    return;
  }

  const tagName = SESSION_STATE_TAG_NAMES[state];
  const tagId = forum.availableTags.find((tag) => tag.name === tagName)?.id;
  if (!tagId) throw new Error(`Session forum is missing required tag: ${tagName}`);
  await thread.edit({
    appliedTags: [...kept, tagId],
    ...(thread.archived ? { archived: false } : {}),
    reason: `Concordia session state: ${state}`,
  });
}

export function hasForumSessionState(thread: ForumSessionThread, state: ChannelDisplayState): boolean {
  if (state === "ended" || state === "lost") return thread.archived === true;
  const forum = thread.parent as ForumChannel | null;
  const tagName = SESSION_STATE_TAG_NAMES[state];
  const tagId = forum?.availableTags.find((tag) => tag.name === tagName)?.id;
  return !!tagId && thread.appliedTags.includes(tagId);
}

export function buildForumThreadTitle(
  projectCode: string,
  summary: string,
  delegationEmoji?: string | null,
): string {
  const normalizedSummary = summary.replace(/\s+/g, " ").trim() || "session";
  const emojiPrefix = delegationEmoji?.trim() ? `${delegationEmoji.trim()} ` : "";
  return `${emojiPrefix}[${projectCode}] ${normalizedSummary}`.slice(0, 100);
}

export function buildForumStarterContent(guildId: string, input: ForumSessionMetadata): string {
  const repoName = input.repoPath.split(/[\\/]/).filter(Boolean).pop() || input.repoPath;
  const statusLink = input.statusCardChannelId
    ? `https://discord.com/channels/${guildId}/${input.statusCardChannelId}`
    : "準備中";
  const lines = [
    `**${input.surfaceLabel ?? "Session"}** \`${input.sessionId}\``,
    `**Repo** \`${repoName}\` — \`${input.repoPath}\``,
    `**作業ブランチ** ${formatWorkingBranch(input.branch)}`,
    `**Runtime** model \`${input.model ?? "-"}\` · effort \`${input.effortLevel ?? "-"}\` · fast ${formatFastMode(input.fastMode)}`,
    `**状態カード** ${statusLink}`,
  ];
  if (input.delegationRunId) lines.splice(1, 0, `**Delegation run** \`${input.delegationRunId}\``);
  return lines.join("\n");
}
