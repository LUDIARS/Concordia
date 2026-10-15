/**
 * 巡回の bot 発言への人間の直接返信を受理する (spec/feature/patrol-chat.md §7)。
 *
 * chat.posted は起床通知であり、 受理の正本は rule_inbound (inbound ID の PK)。
 * - 返信先 (in_reply_to) が巡回会話の bot 発言であること
 * - 人間の発言であること (巡回自身・他 bot・system は受けない。 CC-PATROL-04)
 * - 会話と同じ宛先であること (別チャンネルの発言を会話へ混ぜない)
 */

import type { ChatMessageRow } from "../db/chat-repo.js";
import { PATROL_MESSAGE_SOURCE, nowSecOf, type PatrolPorts } from "./patrol-ports.js";

export type InboundResult =
  | { accepted: true; conversationId: string }
  | { accepted: false; reason: string };

function metadataOf(msg: ChatMessageRow): Record<string, unknown> {
  if (!msg.metadata) return {};
  try {
    const v = JSON.parse(msg.metadata) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 発言の個別チャンネル (巡回投稿の投稿先 / 個別チャンネルで受けた返信)。 本社の発言は null。 */
export function externalChannelOfMessage(msg: ChatMessageRow | null): string | null {
  if (!msg) return null;
  const id = metadataOf(msg).patrol_discord_channel_id;
  return typeof id === "string" && id !== "" ? id : null;
}

/** 人間起源の発言か。 Discord ingress (bot 除外済み) か、 明示の human origin だけを認める。 */
export function isHumanMessage(msg: ChatMessageRow): boolean {
  const meta = metadataOf(msg);
  if (meta.source === PATROL_MESSAGE_SOURCE) return false;
  if (meta.source === "discord" && typeof meta.discord_user_id === "string" && meta.discord_user_id !== "") return true;
  return meta.origin === "human";
}

export function acceptInbound(ports: Pick<PatrolPorts, "chat" | "conversations" | "nowMs">, messageId: number): InboundResult {
  const msg = ports.chat.findById(messageId);
  if (!msg) return { accepted: false, reason: "message not found" };
  if (msg.in_reply_to === null) return { accepted: false, reason: "not a reply" };
  if (!isHumanMessage(msg)) return { accepted: false, reason: "not a human message" };
  const conv = ports.conversations.findByBotMessage(msg.in_reply_to);
  if (!conv) return { accepted: false, reason: "not a patrol conversation" };
  const now = nowSecOf(ports);
  if (conv.status !== "open" || now >= conv.expires_at) return { accepted: false, reason: "conversation closed" };
  if (conv.channel !== msg.channel) return { accepted: false, reason: "different destination" };
  // 個別チャンネルの会話には、 そのチャンネルでの返信だけを受ける (本社と子会社の発言を混ぜない)。
  if (externalChannelOfMessage(msg) !== externalChannelOfMessage(ports.chat.findById(conv.root_chat_id))) {
    return { accepted: false, reason: "different destination" };
  }
  if (!ports.conversations.recordInbound(msg.id, conv.conversation_id, now)) {
    return { accepted: false, reason: "already received" };
  }
  return { accepted: true, conversationId: conv.conversation_id };
}
