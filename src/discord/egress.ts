import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Guild } from "discord.js";
import type { ChatMessageRelay, ChatReadModel } from "../platform/chat-read-model.js";
import type { DiscordMessageMapRepo, DiscordSessionChannelsRepo } from "../db/discord-repo.js";
import type { SessionMessageDeliveryRepo } from "../db/session-message-delivery-repo.js";
import type { ConcordiaEvent } from "../events.js";
import type { Attachment, SessionMessagePayload } from "../shared/session-message-types.js";
import type { DiscordConfigSnapshot } from "./config.js";
import { formatAuthorName } from "./formatter.js";
import { chatChannelToMetaKind, type MetaChannelKind } from "./types.js";
import type { WebhookPool } from "./webhook-pool.js";
import { withinTeardownGrace } from "../platform/session-teardown-grace.js";
import { buildDiscordWebhookIdentity } from "./webhook-identity.js";
import { buildAttachmentRoots, createAttachmentGuard } from "../shared/attachment-paths.js";
import { configuredAttachmentRoots, isAttachmentEnforced } from "../config/attachment-policy.js";

const DISCORD_ATTACH_MAX_BYTES = 24 * 1024 * 1024; // 24 MiB (Discord 25 MiB limit)
const BASE64_BYTES_PER_QUARTET = 3;
const MAX_DISCORD_ATTACH_BASE64_LENGTH = Math.ceil(DISCORD_ATTACH_MAX_BYTES / BASE64_BYTES_PER_QUARTET) * 4;

export function getEgressDedupStats(): { skipped_chat_posted: number; skipped_transcript_frame: number; total: number } {
  // D6 以降、transcript.frame と chat.posted を内容で突き合わせる時間窓 dedupe は不要。
  // Canonical session messages are idempotent through (session_id, dedupe_key).
  return { skipped_chat_posted: 0, skipped_transcript_frame: 0, total: 0 };
}

export interface EgressDeps {
  guild: Guild;
  layout: DiscordConfigSnapshot;
  webhooks: WebhookPool;
  readModel: ChatReadModel;
  sessionChannelsRepo: DiscordSessionChannelsRepo;
  messageMap: DiscordMessageMapRepo;
  deliveryRepo: SessionMessageDeliveryRepo;
  messageOptimizationEnabled?: boolean;
  resolveWorkspaceRoots?: () => string[];
  /** A canonical session message reached Discord. */
  onSessionMessagePosted?: (input: { sessionId: string; completion: boolean }) => void;
  log: { warn: (m: string) => void };
}

export function handleEvent(deps: EgressDeps, ev: ConcordiaEvent): void {
  if (ev.type === "chat.posted") {
    void handleChatPosted(deps, ev).catch((err) => {
      deps.log.warn(`egress: chat.posted dispatch failed message_id=${ev.message_id}: ${(err as Error).message}`);
    });
    return;
  }
  if (ev.type === "session.message") {
    void handleSessionMessage(deps, ev).catch((err) => {
      deps.log.warn(`egress: session.message dispatch failed session=${ev.target_session_id} message=${ev.message.id}: ${(err as Error).message}`);
    });
  }
}

async function handleChatPosted(deps: EgressDeps, ev: Extract<ConcordiaEvent, { type: "chat.posted" }>): Promise<void> {
  const row = deps.readModel.getChatMessage(ev.message_id);
  if (!row) {
    deps.log.warn(`egress.handleChatPosted row missing message_id=${ev.message_id}`);
    return;
  }
  // Discord ingress 経由で入った chat は既に元投稿として Discord 側に表示
  // されているので、 ここで再 broadcast すると同じテキストが自分の channel に
  // webhook 名義で再出現する自己ループになる. metadata.source==="discord" は
  // ingress が必ず埋める marker (src/discord/ingress.ts L126).
  const chatMeta = row.metadata;
  if (chatMeta.source === "discord") return;
  const sessionId = row.sessionId;
  const sessionRow = sessionId ? deps.sessionChannelsRepo.findBySessionId(sessionId) : null;
  const session = sessionId ? deps.readModel.getSessionRelayState(sessionId) : null;
  if (!isChatRelayTarget(sessionId, session?.status ?? null, sessionRow?.status ?? null, session?.endedAt ?? null)) {
    deps.log.warn(
      `egress.handleChatPosted skipped unrelayable session message_id=${row.id} row_session_id=${sessionId ?? "null"} ` +
      `session_status=${session?.status ?? "null"} discord_status=${sessionRow?.status ?? "null"} ` +
      `session_channel=${sessionRow?.channel_id ?? "null"}`,
    );
    return;
  }
  const metaKind = mapChannelKind(row.channel, ev.channel);
  const metaChannelId = deps.layout.metaChannels[metaKind] ?? null;
  const forceMeta = row.channel === "chitchat" || row.channel === "consultation" || row.channel === "報告";
  // Lictor が握る送信先を明示してきた場合でも、session-scoped な通常投稿では
  // Concordia が最初に記録した session channel と一致する時だけ採用する。
  const explicitChannelId = chatMeta.discord_channel_id ?? null;
  const trustedExplicitChannelId = trustedDiscordChannelId({
    explicitChannelId,
    sessionId,
    sessionChannelId: sessionRow?.channel_id ?? null,
    forceMeta,
  });
  if (explicitChannelId && trustedExplicitChannelId !== explicitChannelId) {
    deps.log.warn(
      `egress.handleChatPosted ignored discord_channel_id mismatch message_id=${row.id} ` +
      `row_session_id=${sessionId ?? "null"} explicit=${explicitChannelId} ` +
      `session_channel=${sessionRow?.channel_id ?? "null"}`,
    );
  }
  const channelId = trustedExplicitChannelId
    ? trustedExplicitChannelId
    : forceMeta
      ? metaChannelId
      : (sessionRow ? sessionRow.channel_id : metaChannelId);
  if (!channelId) {
    deps.log.warn(`egress.handleChatPosted no channel resolved message_id=${row.id} row_session_id=${sessionId ?? "null"}`);
    return;
  }
  // Forum thread は親 forum の共有 webhook + thread_id が必要なので、明示指定でも
  // session surface と一致する場合は session 経路を使う。meta の明示指定だけ channel 経路。
  const isSessionSurface = !!sessionRow && !!sessionId && channelId === sessionRow.channel_id;
  const client = isSessionSurface
    ? await deps.webhooks.getForSession(sessionId)
    : await deps.webhooks.getForChannel(channelId);
  if (!client) {
    deps.log.warn(`egress.handleChatPosted no webhook client message_id=${row.id} channel=${channelId} sessionRow=${sessionRow ? "yes" : "no"}`);
    return;
  }

  const author = resolveAuthor(row);
  const attachFiles = await buildAttachFiles(chatMeta.attachment_paths, row.id, deps.log, deps.resolveWorkspaceRoots?.() ?? []);
  const identity = session
    ? buildDiscordWebhookIdentity({
        model: session.model,
        provider: session.provider,
        configuredName: session.webhookName,
        currentTask: session.currentTask,
        roleLabel: session.roleLabel,
        fallbackName: author,
        delegationEmoji: session.delegationEmoji,
      })
    : null;
  const res = await deps.webhooks.send(client, {
    content: row.text,
    username: chatMeta.webhook_username?.trim() || identity?.username || author,
    ...(chatMeta.webhook_avatar_url?.trim() || identity?.avatarURL || session?.webhookAvatarUrl?.trim()
      ? { avatarURL: chatMeta.webhook_avatar_url?.trim() || identity?.avatarURL || session?.webhookAvatarUrl?.trim() }
      : {}),
    ...(attachFiles.length > 0 ? { files: attachFiles } : {}),
  });
  if (res) {
    deps.messageMap.put(res.id, row.id);
    return;
  }
  deps.log.warn(`egress: chat.posted relay returned empty response message_id=${row.id} channel=${channelId}`);
}

async function handleSessionMessage(
  deps: EgressDeps,
  ev: Extract<ConcordiaEvent, { type: "session.message" }>,
): Promise<void> {
  const session = deps.readModel.getSessionRelayState(ev.target_session_id);
  const sessionRow = deps.sessionChannelsRepo.findBySessionId(ev.target_session_id);
  if (!isActiveRelayTarget(session?.status ?? null, sessionRow?.status ?? null, session?.endedAt ?? null)) return;
  if (!session) {
    deps.log.warn(`egress: session.message active check inconsistent session=${ev.target_session_id} message=${ev.message.id}`);
    return;
  }
  // Discord ingress is already the original message on its channel. Reposting its
  // canonical projection would create an immediate self-echo.
  if (ev.message.author_platform === "discord") return;
  // Questions and permission requests retain their interactive Discord adapters.
  // Their canonical records remain the WebUI source of truth; the specialized
  // adapter owns buttons and their state transitions until it is migrated.
  if (ev.message.author_type === "question" || ev.message.author_type === "permission") return;
  if (ev.message.author_type === "thinking" && deps.messageOptimizationEnabled) return;
  // A tool-use is updated with its final outcome. Posting the create event would
  // expose a transient "running" entry and leave the final state in a second
  // Discord message, so only relay the final update.
  if (ev.message.author_type === "tool" && ev.op === "create") return;

  const content = formatSessionMessageContent(ev.message);
  const existingDiscordId = deps.deliveryRepo.findExternalId(ev.message.id, "discord");
  if (ev.op === "update" && existingDiscordId) {
    const edited = await deps.webhooks.editForSession(ev.target_session_id, existingDiscordId, content);
    if (edited) {
      deps.onSessionMessagePosted?.({ sessionId: ev.target_session_id, completion: isCompletionMessage(ev.message) });
      return;
    }
    deps.log.warn(`egress: session.message edit failed session=${ev.target_session_id} message=${ev.message.id}`);
    return;
  }
  if (existingDiscordId) return;

  const client = await deps.webhooks.getForSession(ev.target_session_id);
  if (!client) {
    deps.log.warn(`egress: session.message no webhook client session=${ev.target_session_id} message=${ev.message.id}`);
    return;
  }
  const identity = buildDiscordWebhookIdentity({
    model: session.model,
    provider: session.provider,
    callName: messageCallName(ev.message),
    configuredName: session.webhookName,
    currentTask: session.currentTask,
    roleLabel: session.roleLabel,
    fallbackName: ev.message.author_label || formatAuthorName(null, session.roleLabel),
    delegationEmoji: session.delegationEmoji,
  });
  const files = filesFromAttachments(ev.message.attachments);
  const res = await deps.webhooks.send(client, {
    content,
    username: identity.username,
    allowedMentions: { parse: [] },
    ...(identity.avatarURL || session.webhookAvatarUrl?.trim()
      ? { avatarURL: identity.avatarURL || session.webhookAvatarUrl!.trim() }
      : {}),
    ...(files.length > 0
      ? { files }
      : {}),
  });
  if (!res) {
    deps.log.warn(`egress: session.message relay returned empty response session=${ev.target_session_id} message=${ev.message.id}`);
    return;
  }
  deps.deliveryRepo.put({ message_id: ev.message.id, platform: "discord", external_id: res.id, ts: ev.ts });
  deps.onSessionMessagePosted?.({ sessionId: ev.target_session_id, completion: isCompletionMessage(ev.message) });
}

function formatSessionMessageContent(message: SessionMessagePayload): string {
  const content = message.content || "(attachment)";
  if (message.author_type === "thinking") return content.split("\n").map((line) => `> ${line}`).join("\n");
  if (message.author_type === "task") return `**Task**\n${content}`;
  if (message.author_type === "tool") return `${formatToolLabel(message.author_label)}: ${content}`;
  return content;
}

function formatToolLabel(label: string): string {
  if (!/(?:^|[^a-z0-9])(?:cc|concordia|ludiars)(?:$|[^a-z0-9])/i.test(label)) return label;
  return `\`${label.replaceAll("`", "\\`")}\``;
}

function messageCallName(message: SessionMessagePayload): string | null {
  if (message.author_type === "summary") return "Conversation summary";
  if (message.author_type === "delegation") return "Cc delegation";
  if (message.author_type === "task") return "Task";
  return null;
}

function filesFromAttachments(attachments: Attachment[] | null): Array<{ attachment: Buffer; name: string }> {
  const files: Array<{ attachment: Buffer; name: string }> = [];
  let totalBytes = 0;
  for (const [index, attachment] of (attachments ?? []).entries()) {
    // Attachment data originates outside the Discord adapter. Bound the encoded
    // input before decoding so an oversized canonical record cannot allocate an
    // unbounded Buffer in the egress process.
    if (attachment.data.length > MAX_DISCORD_ATTACH_BASE64_LENGTH) continue;
    const data = Buffer.from(attachment.data, "base64");
    if (
      data.length === 0
      || data.length > DISCORD_ATTACH_MAX_BYTES
      || totalBytes + data.length > DISCORD_ATTACH_MAX_BYTES
    ) continue;
    files.push({
      attachment: data,
      name: `attachment-${index + 1}.${attachment.media_type.includes("png") ? "png" : "jpg"}`,
    });
    totalBytes += data.length;
  }
  return files;
}

function isCompletionMessage(message: SessionMessagePayload): boolean {
  if (message.author_type !== "task") return false;
  return message.metadata?.is_error === true || message.embeds?.some((embed) =>
    embed.fields?.some((field) => field.name === "status" && (field.value === "completed" || field.value === "failed")),
  ) === true;
}

function mapChannelKind(rowChannel: string, evChannel: string): MetaChannelKind {
  const fromRow = chatChannelToMetaKind(rowChannel as never);
  if (fromRow) return fromRow;
  if (evChannel === "houkoku" || evChannel === "報告") return "houkoku";
  return "system";
}

function resolveAuthor(row: ChatMessageRelay): string {
  return row.authorLabel?.trim() || "Concordia";
}

export function trustedDiscordChannelId(input: {
  explicitChannelId: string | null;
  sessionId: string | null;
  sessionChannelId: string | null;
  forceMeta: boolean;
}): string | null {
  if (!input.explicitChannelId) return null;
  if (!input.sessionId) return null;
  if (input.forceMeta) return input.explicitChannelId;
  if (!input.sessionChannelId) return null;
  return input.explicitChannelId === input.sessionChannelId ? input.explicitChannelId : null;
}

export function isChatRelayTarget(
  sessionId: string | null | undefined,
  sessionStatus: string | null | undefined,
  discordStatus: string | null | undefined,
  endedAtSec?: number | null,
  nowSec: number = Math.floor(Date.now() / 1000),
): boolean {
  return !!sessionId && isActiveRelayTarget(sessionStatus, discordStatus, endedAtSec, nowSec);
}

export function isActiveRelayTarget(
  sessionStatus: string | null | undefined,
  discordStatus: string | null | undefined,
  endedAtSec?: number | null,
  nowSec: number = Math.floor(Date.now() / 1000),
): boolean {
  if (discordStatus !== "active") return false;
  if (sessionStatus === "active") return true;
  // teardown 猶予: platform/session-teardown-grace.ts 参照 (最終応答 frame と
  // session-end 独白は ended 直後に届くため、 厳密 active 判定だと必ず落ちる)。
  return withinTeardownGrace(sessionStatus, endedAtSec, nowSec);
}

async function buildAttachFiles(
  rawPaths: string[] | undefined,
  messageId: number,
  log: { warn: (m: string) => void },
  workspaceRoots: string[],
): Promise<Array<{ attachment: Buffer; name: string }>> {
  if (!rawPaths?.length) return [];
  const enforce = isAttachmentEnforced();
  const guard = createAttachmentGuard({
    roots: buildAttachmentRoots({
      workspaceRoots,
      tempDir: os.tmpdir(),
      configuredRoots: configuredAttachmentRoots(),
    }),
    enforce,
  });
  const out: Array<{ attachment: Buffer; name: string }> = [];
  for (const p of rawPaths) {
    const result = await guard.check(p);
    if (!result.ok) {
      log.warn(`egress: attachment rejected message_id=${messageId} reason=${result.reason} path=${p}`);
      if (enforce) continue;
    }
    const absPath = result.ok ? result.realPath : p;
    if (!path.isAbsolute(absPath)) {
      log.warn(`egress: attachment skipped (not absolute) message_id=${messageId} path=${p}`);
      continue;
    }
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(absPath);
    } catch {
      log.warn(`egress: attachment not found message_id=${messageId} path=${absPath}`);
      continue;
    }
    if (stat.size > DISCORD_ATTACH_MAX_BYTES) {
      log.warn(`egress: attachment too large (${stat.size}B) message_id=${messageId} path=${absPath}`);
      continue;
    }
    try {
      const buf = await fs.promises.readFile(absPath);
      out.push({ attachment: buf, name: path.basename(absPath) });
    } catch (err) {
      log.warn(`egress: attachment read failed message_id=${messageId} path=${absPath}: ${(err as Error).message}`);
    }
  }
  return out;
}
