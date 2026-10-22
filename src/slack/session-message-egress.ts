/**
 * src/slack/session-message-egress.ts — canonical session message を Slack の session channel へ流す。
 *
 * Discord egress と同じ規則で出し分ける: 内容判定は platform/session-message-relay.ts、 部署の出力方針
 * (途中の発言・Cc の指令の転記) は platform/relay-output-filter.ts。 1 発言 1 投稿で、 update は
 * 配送記録 (session_message_delivery, platform=slack) から投稿を引いて chat.update する。
 * ターン中の状態表示 (response_turn) は Slack 側の working indicator が持つので流さない。
 * ユーザー入力は Slack がまだ見ていない ingress (web) だけを流す (Discord からの指示は転記しない)。
 *
 * SRP: 1 件の session.message の配送だけ。 channel の用意と購読は bot.ts。
 *
 * @implements spec/feature/slack-platform.md — egress
 */

import type { ConcordiaEvent } from "../events.js";
import type { SessionMessageDeliveryRepo } from "../db/session-message-delivery-repo.js";
import type { SessionMessagePayload } from "../shared/session-message-types.js";
import { isRelayableCanonicalMessage } from "../platform/session-message-relay.js";
import { shouldRelaySessionMessage, type RelayOutputPolicy } from "../platform/relay-output-filter.js";
import { wrapTablesInCode } from "../shared/message-blocks.js";
import { sanitizeSlackMentions, truncateForSlack } from "./render.js";

/** Slack が流すユーザー入力の出所。 */
export const SLACK_RELAYED_USER_ORIGINS = ["web"] as const;

const SLACK_MAX_TEXT = 12000;

export interface SlackSessionMessageClient {
  chat: {
    postMessage(args: { channel: string; text: string; username?: string }): Promise<{ ts?: unknown }>;
    update(args: { channel: string; ts: string; text: string }): Promise<unknown>;
  };
}

export interface SlackSessionMessageDeps {
  client: SlackSessionMessageClient;
  deliveries: SessionMessageDeliveryRepo;
  isSessionActive(sessionId: string): boolean;
  /** session channel を用意して ID を返す。 */
  ensureChannel(sessionId: string): Promise<string>;
  /** 投稿者名 (Slack の username)。 */
  authorName(sessionId: string, message: SessionMessagePayload): string;
  relayOutputPolicy?: (sessionId: string) => RelayOutputPolicy;
  log: { warn: (m: string) => void; info: (m: string) => void };
}

export type SlackSessionMessageResult =
  | { posted: false }
  | { posted: true; channelId: string; ts: string; message: SessionMessagePayload };

/** Slack に流す発言か (配送状態は見ない)。 */
export function isSlackRelayableSessionMessage(message: SessionMessagePayload, policy: RelayOutputPolicy | undefined): boolean {
  if (message.metadata?.response_turn === true) return false;
  if (!isRelayableCanonicalMessage(message, { platform: "slack", relayedUserOrigins: SLACK_RELAYED_USER_ORIGINS, hideThinking: true })) return false;
  return !policy || shouldRelaySessionMessage(message, policy);
}

export function formatSlackSessionMessage(message: SessionMessagePayload): string {
  const content = message.content || "(attachment)";
  const text = message.author_type === "task"
    ? `*Task*\n${content}`
    : message.author_type === "tool" ? `${message.author_label}: ${content}` : content;
  return sanitizeSlackMentions(truncateForSlack(wrapTablesInCode(text), SLACK_MAX_TEXT));
}

/** 配送記録の external_id (Slack は channel と ts の組で 1 投稿)。 */
function externalId(channelId: string, ts: string): string {
  return `${channelId}|${ts}`;
}

function parseExternalId(value: string): { channelId: string; ts: string } | null {
  const at = value.indexOf("|");
  return at <= 0 ? null : { channelId: value.slice(0, at), ts: value.slice(at + 1) };
}

export async function relaySessionMessageToSlack(
  deps: SlackSessionMessageDeps,
  ev: Extract<ConcordiaEvent, { type: "session.message" }>,
): Promise<SlackSessionMessageResult> {
  const sessionId = ev.target_session_id;
  if (!deps.isSessionActive(sessionId)) return { posted: false };
  if (!isSlackRelayableSessionMessage(ev.message, deps.relayOutputPolicy?.(sessionId))) return { posted: false };
  const text = formatSlackSessionMessage(ev.message);
  const existing = deps.deliveries.findExternalId(ev.message.id, "slack");
  if (existing) {
    const target = ev.op === "update" ? parseExternalId(existing) : null;
    if (target) {
      try {
        await deps.client.chat.update({ channel: target.channelId, ts: target.ts, text });
      } catch (e) {
        deps.log.warn(`session.message update failed session=${sessionId} message=${ev.message.id}: ${(e as Error).message}`);
      }
    }
    return { posted: false };
  }
  const channelId = await deps.ensureChannel(sessionId);
  try {
    const r = await deps.client.chat.postMessage({ channel: channelId, text, username: deps.authorName(sessionId, ev.message) });
    if (typeof r.ts !== "string") return { posted: false };
    deps.deliveries.put({ message_id: ev.message.id, platform: "slack", external_id: externalId(channelId, r.ts), ts: ev.ts });
    deps.log.info(`[verbose-slack-egress] session.message → channel session=${sessionId} message=${ev.message.id} type=${ev.message.author_type}`);
    return { posted: true, channelId, ts: r.ts, message: ev.message };
  } catch (e) {
    deps.log.warn(`session.message post failed session=${sessionId} message=${ev.message.id}: ${(e as Error).message}`);
    return { posted: false };
  }
}

/**
 * セッションが chat 経路 (lictor chat・圧縮の通知など) で出す投稿を Slack の session channel へ流すか。
 * Discord の shouldRelaySessionChatPost と同じく、 途中の発言を止めた部署では、 本人のセッション宛て
 * (channel=system) の添付つき成果物だけを流す。
 */
export function shouldRelaySlackSessionChat(policy: RelayOutputPolicy, post: { channel: string; attachmentCount: number }): boolean {
  if (policy.intermediate) return true;
  return post.channel === "system" && post.attachmentCount > 0;
}
