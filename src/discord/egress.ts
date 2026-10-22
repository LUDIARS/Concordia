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
import { buildAttachFiles, DISCORD_ATTACH_MAX_BYTES } from "./attachment-files.js";
import {
  isFinalAnswerMessage,
  shouldRelaySessionChatPost,
  shouldRelaySessionMessage,
  type RelayOutputPolicy,
} from "../platform/relay-output-filter.js";
import { isCcInjectEcho, isRelayableCanonicalMessage } from "../platform/session-message-relay.js";

// 既存の呼び出し元 (テスト) 向けに再公開する。
export { isCcInjectEcho };

/** Discord が流すユーザー入力の出所 (Discord 自身の ingress はこだまなので含めない)。 */
const DISCORD_RELAYED_USER_ORIGINS = ["web", "slack"] as const;

const BASE64_BYTES_PER_QUARTET = 3;
const MAX_DISCORD_ATTACH_BASE64_LENGTH = Math.ceil(DISCORD_ATTACH_MAX_BYTES / BASE64_BYTES_PER_QUARTET) * 4;
const messageDeliveries = new WeakMap<EgressDeps, Map<number, Promise<void>>>();

export function getEgressDedupStats(): { skipped_chat_posted: number; skipped_transcript_frame: number; total: number } {
  // D6 以降、transcript.frame と chat.posted を内容で突き合わせる時間窓 dedupe は不要。
  // Canonical session messages are idempotent through (session_id, dedupe_key).
  return { skipped_chat_posted: 0, skipped_transcript_frame: 0, total: 0 };
}

export interface EgressDeps {
  /** 部署の出力方針。 未指定なら全部流す (relay-output-filter.ts)。 */
  relayOutputPolicy?: (sessionId: string) => RelayOutputPolicy;
  guild: Guild;
  layout: DiscordConfigSnapshot;
  webhooks: WebhookPool;
  readModel: ChatReadModel;
  sessionChannelsRepo: DiscordSessionChannelsRepo;
  messageMap: DiscordMessageMapRepo;
  deliveryRepo: SessionMessageDeliveryRepo;
  messageOptimizationEnabled?: boolean;
  resolveWorkspaceRoots?: () => string[];
  /**
   * ready の報告用プライベートチャンネルか (spec/feature/private-channels.md §4)。 そうなら明示された
   * discord_channel_id をセッションの有無に関係なく採用する (CC-PRIVCH-INV-03)。
   */
  isReadyPrivateChannel?: (channelId: string) => boolean;
  /** A canonical session message reached Discord. */
  onSessionMessagePosted?: (input: {
    sessionId: string;
    completion: boolean;
    /**
     * セッション自身が最終応答 (assistant) か会話要約 (summary) を出した =
     * **ターンが終わってアイドルへ落ちた**。 `completion` は delegation の task
     * カード専用なので、 セッションのアイドル判定には使えない (別 signal にする)。
     */
    turnEnd: boolean;
  }) => void;
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
    let deliveries = messageDeliveries.get(deps);
    if (!deliveries) { deliveries = new Map(); messageDeliveries.set(deps, deliveries); }
    const queue = deliveries;
    const pending = (queue.get(ev.message.id) ?? Promise.resolve()).then(() => handleSessionMessage(deps, ev)).catch((err) => {
      deps.log.warn(`egress: session.message dispatch failed session=${ev.target_session_id} message=${ev.message.id}: ${(err as Error).message}`);
    });
    queue.set(ev.message.id, pending);
    void pending.finally(() => { if (queue.get(ev.message.id) === pending) queue.delete(ev.message.id); });
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
  // Final-only departments retain explicit own-surface artifact delivery.
  const chatPolicy = sessionId ? deps.relayOutputPolicy?.(sessionId) : undefined;
  const sessionRow = sessionId ? deps.sessionChannelsRepo.findBySessionId(sessionId) : null;
  const session = sessionId ? deps.readModel.getSessionRelayState(sessionId) : null;
  const chatPost = {
    channel: row.channel,
    sessionId,
    explicitChannelId: chatMeta.discord_channel_id ?? null,
    sessionChannelId: sessionRow?.channel_id ?? null,
    attachmentCount: chatMeta.attachment_paths?.length ?? 0,
  };
  // Envelope check only: the accepted file count is checked again before sending.
  if (chatPolicy && !shouldRelaySessionChatPost(chatPolicy, chatPost)) {
    // Meta-channel posts from a final-only session stay blocked (a private consultation
    // must not leak there), but never silently: the sender only saw a successful POST
    // (Actio 84c50291). The session's own intermediate chatter is too frequent to log.
    if (row.channel !== "system") {
      deps.log.warn(
        `egress.handleChatPosted dropped a meta-channel post from a final-only session message_id=${row.id} ` +
        `channel=${row.channel} row_session_id=${sessionId ?? "null"}`,
      );
    }
    return;
  }
  const artifactOnly = chatPolicy?.intermediate === false;
  if (artifactOnly && (session?.status !== "active" || sessionRow?.status !== "active")) return;
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
  const forceMeta = row.channel === "chitchat" || row.channel === "consultation"
    || row.channel === "報告" || row.channel === "genius";
  // Lictor が握る送信先を明示してきた場合でも、session-scoped な通常投稿では
  // Concordia が最初に記録した session channel と一致する時だけ採用する。
  const explicitChannelId = chatMeta.discord_channel_id ?? null;
  const trustedExplicitChannelId = trustedDiscordChannelId({
    explicitChannelId,
    sessionId,
    sessionChannelId: sessionRow?.channel_id ?? null,
    forceMeta,
    isReadyPrivateChannel: explicitChannelId ? deps.isReadyPrivateChannel?.(explicitChannelId) === true : false,
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
  const attachFiles = await buildAttachFiles(
    chatMeta.attachment_paths,
    `message_id=${row.id}`,
    deps.log,
    deps.resolveWorkspaceRoots?.() ?? [],
  );
  if (chatPolicy && !shouldRelaySessionChatPost(chatPolicy, { ...chatPost, attachmentCount: attachFiles.length })) return;
  // File I/O can outlive the session or its surface. Never route this exception
  // to a replacement channel or create a late artifact in the teardown window.
  if (artifactOnly && sessionId) {
    const currentSurface = deps.sessionChannelsRepo.findBySessionId(sessionId);
    const currentSession = deps.readModel.getSessionRelayState(sessionId);
    if (currentSession?.status !== "active" || currentSurface?.status !== "active"
      || currentSurface.channel_id !== channelId) return;
  }
  const client = isSessionSurface
    ? await deps.webhooks.getForSession(sessionId)
    : await deps.webhooks.getForChannel(channelId);
  if (!client) {
    deps.log.warn(`egress.handleChatPosted no webhook client message_id=${row.id} channel=${channelId} sessionRow=${sessionRow ? "yes" : "no"}`);
    return;
  }
  // Webhook lookup is asynchronous too; its completion grants no new lifetime.
  if (artifactOnly && sessionId) {
    const currentSurface = deps.sessionChannelsRepo.findBySessionId(sessionId);
    if (deps.readModel.getSessionRelayState(sessionId)?.status !== "active"
      || currentSurface?.status !== "active" || currentSurface.channel_id !== channelId) return;
  }

  const author = resolveAuthor(row);
  const mentionUserIds = [...new Set(
    (ev.mention_user_ids?.discord ?? []).filter((id) => /^\d{17,20}$/.test(id)),
  )];
  const mentionPrefix = mentionUserIds.map((id) => `<@${id}>`).join(" ");
  const content = mentionPrefix ? `${mentionPrefix} ${row.text}` : row.text;
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
    content,
    username: chatMeta.webhook_username?.trim() || identity?.username || author,
    allowedMentions: mentionUserIds.length > 0
      ? { parse: [], users: mentionUserIds }
      : { parse: [] },
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
  const terminalTurn = ev.message.metadata?.response_turn === true
    && ["completed", "interrupted", "failed"].includes(String(ev.message.metadata.turn_status));
  // A lost/ended session must still clear a status post it already delivered.
  // This exception edits an existing post only; it cannot create late output.
  const terminalDelivery = terminalTurn && deps.deliveryRepo.findExternalId(ev.message.id, "discord");
  if (!isActiveRelayTarget(session?.status ?? null, sessionRow?.status ?? null, session?.endedAt ?? null) && !terminalDelivery) return;
  if (!session) {
    deps.log.warn(`egress: session.message active check inconsistent session=${ev.target_session_id} message=${ev.message.id}`);
    return;
  }
  // Discord / Slack 共通の内容判定 (platform/session-message-relay.ts)。 Discord 自身の ingress は
  // こだま、 質問と許可要求は専用アダプタ、 成功したツール・端末入力や自動注入のユーザー発言・
  // Cc 自身の inject ([自動確認] / [Cc policy update] など、 cc-inject-mirror が 1 行だけ通知する) は流さない。
  // ユーザー入力は Discord がまだ見ていない ingress (web / slack) だけを流す。
  if (!isRelayableCanonicalMessage(ev.message, {
    platform: "discord",
    relayedUserOrigins: DISCORD_RELAYED_USER_ORIGINS,
    hideThinking: deps.messageOptimizationEnabled === true,
  })) return;
  const outputPolicy = deps.relayOutputPolicy?.(ev.target_session_id);
  if (outputPolicy && !shouldRelaySessionMessage(ev.message, outputPolicy) && !terminalDelivery) return;

  const content = formatSessionMessageContent(ev.message);
  const existingDiscordId = deps.deliveryRepo.findExternalId(ev.message.id, "discord");
  if (ev.op === "update" && existingDiscordId) {
    const edited = await deps.webhooks.editForSession(ev.target_session_id, existingDiscordId, content);
    if (edited) {
      deps.onSessionMessagePosted?.({
        sessionId: ev.target_session_id,
        completion: isCompletionMessage(ev.message),
        turnEnd: isTurnEndMessage(ev.message),
      });
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
  deps.onSessionMessagePosted?.({
    sessionId: ev.target_session_id,
    completion: isCompletionMessage(ev.message),
    turnEnd: isTurnEndMessage(ev.message),
  });
}

/** @implements SPEC-SESSION-CHAT-RESPONSE-WORK — preserve final report text without a Cc heading */
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

/**
 * セッションがターンを終えた合図。
 *
 * Codex の `assistant` は `phase=final_answer` のみ、Claude 系は `summary` を
 * ターン境界とする。phase のない旧 assistant や途中経過を含めると、ターン中に
 * 何度も「終わった」ことになるため推測で補完しない。
 *
 * `isCompletionMessage` と分けているのは、 あちらが **delegation の task カード**
 * (status=completed/failed の embed) だけを見ており、 セッション自身の応答では
 * 発火しないため。 チャンネル名の状態タグはあちらの意味のまま据え置く。
 */
export function isTurnEndMessage(message: SessionMessagePayload): boolean {
  return isFinalReportMessage(message);
}

function isFinalReportMessage(message: SessionMessagePayload): boolean {
  return isFinalAnswerMessage(message);
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
  /** ready の報告用プライベートチャンネル。 セッションに関係なく採用する (CC-PRIVCH-INV-03)。 */
  isReadyPrivateChannel?: boolean;
}): string | null {
  if (!input.explicitChannelId) return null;
  if (input.isReadyPrivateChannel) return input.explicitChannelId;
  if (!input.sessionId) return null;
  if (input.forceMeta) return input.explicitChannelId;
  if (!input.sessionChannelId) return null;
  return input.explicitChannelId === input.sessionChannelId ? input.explicitChannelId : null;
}

/** @implements spec/feature/discord-ui.md — chat.posted routing table */
export function isChatRelayTarget(
  sessionId: string | null | undefined,
  sessionStatus: string | null | undefined,
  discordStatus: string | null | undefined,
  endedAtSec?: number | null,
  nowSec: number = Math.floor(Date.now() / 1000),
): boolean {
  // session に紐付かない chat は meta channel 向けの通知。session surface の
  // lifecycle では止めず、後段の channel-kind 解決で送信先を制限する。
  if (!sessionId) return true;
  return isActiveRelayTarget(sessionStatus, discordStatus, endedAtSec, nowSec);
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
