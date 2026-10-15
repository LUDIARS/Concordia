/**
 * 個別チャンネル (GLab 等の子会社 guild) での巡回投稿への返信を受け取る (spec/feature/patrol-chat.md §個別チャンネル)。
 *
 * 個別チャンネルは meta channel ではないので、 通常の ingress は発言を捨てる。 ここでは
 * 「巡回投稿 (discord_message_map にある) への Discord 返信」だけを chat 行にする。
 * - 返信先の chat 行が巡回投稿 (metadata.source=patrol) で、 その投稿先がこのチャンネルであること
 * - 返信でない発言 (チャンネルの雑談) は取り込まない (本社 DB に子会社の雑談を溜めない)
 * 作る chat 行には metadata.patrol_discord_channel_id を付け、 本社の Discord / Slack へ転記しない。
 */

import type { ChatMessageRow } from "../db/chat-repo.js";

export interface PatrolReplyLookup {
  messageMap?: { findChatId(discordMessageId: string): number | null };
  chatRepo?: { findById(id: number): ChatMessageRow | null };
}

export interface PatrolReplyTarget {
  /** 返信先の巡回投稿 (chat 行 ID)。 */
  chatId: number;
  /** 巡回投稿の chat channel (会話と同じ宛先にする)。 */
  channel: string;
  /** 個別チャンネル (Discord channel ID)。 */
  discordChannelId: string;
}

function metaOf(row: ChatMessageRow): Record<string, unknown> {
  try {
    const v = JSON.parse(row.metadata ?? "{}") as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Discord の返信が、 このチャンネルへ出した巡回投稿への返信なら、 その対象を返す。 */
export function resolvePatrolChannelReply(
  deps: PatrolReplyLookup,
  msg: { channelId: string; referenceMessageId: string | null | undefined },
): PatrolReplyTarget | null {
  if (!msg.referenceMessageId || !deps.messageMap || !deps.chatRepo) return null;
  const chatId = deps.messageMap.findChatId(msg.referenceMessageId);
  if (chatId == null) return null;
  const row = deps.chatRepo.findById(chatId);
  if (!row) return null;
  const meta = metaOf(row);
  if (meta.source !== "patrol" || meta.patrol_discord_channel_id !== msg.channelId) return null;
  return { chatId, channel: row.channel, discordChannelId: msg.channelId };
}

/** 返信を記録する chat 行の本文。 /v1/chat へそのまま送る。 */
export function patrolReplyChatBody(
  target: PatrolReplyTarget,
  input: { text: string; authorLabel: string; discordUserId: string; discordMessageId: string },
): Record<string, unknown> {
  return {
    channel: target.channel,
    text: input.text.slice(0, 2000),
    author_label: input.authorLabel,
    in_reply_to: target.chatId,
    metadata: {
      source: "discord",
      discord_user_id: input.discordUserId,
      discord_message_id: input.discordMessageId,
      patrol_discord_channel_id: target.discordChannelId,
    },
  };
}
