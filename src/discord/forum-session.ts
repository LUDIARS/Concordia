import {
  ChannelType,
  type ForumChannel,
  type Guild,
  type PublicThreadChannel,
} from "discord.js";
import type { ChannelDisplayState } from "../db/discord-repo.js";
import { SESSION_STATE_TAG_NAMES } from "./config.js";

export interface ForumSessionMetadata {
  sessionId: string;
  repoPath: string;
  branch: string | null;
  statusCardChannelId?: string | null;
}

export interface CreateForumSessionInput extends ForumSessionMetadata {
  projectCode: string;
  summary: string | null;
  fallbackLabel: string;
}

export type ForumSessionThread = PublicThreadChannel<true>;

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
  input: CreateForumSessionInput,
): Promise<ForumSessionThread> {
  const forum = guild.channels.cache.get(forumId);
  if (!forum || forum.type !== ChannelType.GuildForum) {
    throw new Error(`Session forum is unavailable: ${forumId || "(empty id)"}`);
  }
  const waitingTagId = forum.availableTags.find((tag) => tag.name === SESSION_STATE_TAG_NAMES.active)?.id;
  if (!waitingTagId) {
    throw new Error(`Session forum is missing required tag: ${SESSION_STATE_TAG_NAMES.active}`);
  }
  return forum.threads.create({
    name: buildForumThreadTitle(input.projectCode, input.summary ?? input.fallbackLabel),
    message: { content: buildForumStarterContent(guild.id, input) },
    appliedTags: [waitingTagId],
    reason: `Concordia session ${input.sessionId} started`,
  });
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

export async function updateForumSessionStarter(
  guild: Guild,
  thread: ForumSessionThread,
  metadata: ForumSessionMetadata,
  surfaceMessageId?: string | null,
): Promise<void> {
  const message = surfaceMessageId
    ? await thread.messages.fetch(surfaceMessageId)
    : await thread.fetchStarterMessage();
  if (!message) throw new Error(`Forum session metadata message is unavailable: ${thread.id}`);
  await message.edit({ content: buildForumStarterContent(guild.id, metadata) });
}

export async function postForumSessionMetadata(
  guild: Guild,
  thread: ForumSessionThread,
  metadata: ForumSessionMetadata,
): Promise<string> {
  const message = await thread.send({ content: buildForumStarterContent(guild.id, metadata) });
  return message.id;
}

export async function updateForumSessionTitle(
  thread: ForumSessionThread,
  projectCode: string,
  summary: string,
): Promise<string> {
  const name = buildForumThreadTitle(projectCode, summary);
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

  if (state === "ended") {
    await thread.edit({ appliedTags: kept, archived: true, reason: "Concordia session ended" });
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
  if (state === "ended") return thread.archived === true;
  const forum = thread.parent as ForumChannel | null;
  const tagName = SESSION_STATE_TAG_NAMES[state];
  const tagId = forum?.availableTags.find((tag) => tag.name === tagName)?.id;
  return !!tagId && thread.appliedTags.includes(tagId);
}

export function buildForumThreadTitle(projectCode: string, summary: string): string {
  const normalizedSummary = summary.replace(/\s+/g, " ").trim() || "session";
  return `[${projectCode}] ${normalizedSummary}`.slice(0, 100);
}

export function buildForumStarterContent(guildId: string, input: ForumSessionMetadata): string {
  const repoName = input.repoPath.split(/[\\/]/).filter(Boolean).pop() || input.repoPath;
  const statusLink = input.statusCardChannelId
    ? `https://discord.com/channels/${guildId}/${input.statusCardChannelId}`
    : "準備中";
  return [
    `**Session** \`${input.sessionId}\``,
    `**Repo** \`${repoName}\` — \`${input.repoPath}\``,
    `**Branch** \`${input.branch ?? "-"}\``,
    `**状態カード** ${statusLink}`,
  ].join("\n");
}
