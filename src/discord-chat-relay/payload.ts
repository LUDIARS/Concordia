/**
 * 転送本文 (spec/feature/discord-chat-relay.md §転送)。 version 1。
 *
 * @implements spec/feature/discord-chat-relay.md — 転送
 */

/** Discord の発言から中継に要る分だけを取り出した形。 Discord の型には依存しない。 */
export interface DiscordChatMessage {
  messageId: string;
  guildId: string;
  /** 発言のあったチャンネル (スレッドならスレッド自身)。 */
  channelId: string;
  /** スレッドなら親チャンネル。 */
  parentId: string | null;
  authorId: string;
  authorDisplayName: string;
  text: string;
  mentionsBot: boolean;
  sentAt: Date;
}

export interface DiscordRelayPayload {
  version: 1;
  messageId: string;
  channelId: string;
  threadId: string | null;
  guildId: string;
  author: { id: string; displayName: string };
  text: string;
  mentionsBot: boolean;
  sentAt: string;
}

/** channelId / threadId は振り分け (routing.ts) の結果を使う。 */
export function buildDiscordRelayPayload(
  message: DiscordChatMessage,
  route: { channelId: string; threadId: string | null },
): DiscordRelayPayload {
  return {
    version: 1,
    messageId: message.messageId,
    channelId: route.channelId,
    threadId: route.threadId,
    guildId: message.guildId,
    author: { id: message.authorId, displayName: message.authorDisplayName },
    text: message.text,
    mentionsBot: message.mentionsBot,
    sentAt: message.sentAt.toISOString(),
  };
}
