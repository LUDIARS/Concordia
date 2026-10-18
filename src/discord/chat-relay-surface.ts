/**
 * Discord チャット中継の Discord 面 (spec/feature/discord-chat-relay.md §受信 / §サービスの応答と Discord への投稿)。
 *
 * bot の messageCreate から他の ingress より先に呼ばれる。 受け持つと判定した発言は
 * 中継サービスへ渡し、 返事を元の発言への reply として投稿する。 ログには target 名と
 * 失敗種別だけを出す (本文・発言者名・トークンは出さない、 DCR-INV-09)。
 *
 * @implements spec/feature/discord-chat-relay.md — 受信
 */

import type { DiscordChatRelayService } from "../discord-chat-relay/relay-service.js";
import type { DiscordMessagePlace } from "../discord-chat-relay/routing.js";

/** discord.js の Message のうち中継に使う部分。 テストではこの形の代役を渡す。 */
export interface ChatRelaySurfaceMessage {
  id: string;
  guildId: string | null;
  channelId: string;
  content: string;
  webhookId: string | null;
  system: boolean;
  createdAt: Date;
  author: { id: string; bot: boolean; username: string; globalName?: string | null };
  member?: { displayName: string } | null;
  mentions: { users: { has(id: string): boolean } };
  channel: { isThread(): boolean; parentId?: string | null };
  reply(options: { content: string; allowedMentions: { parse: []; repliedUser: boolean } }): Promise<unknown>;
}

export interface ChatRelaySurface {
  handlesMessage: (message: ChatRelaySurfaceMessage) => boolean;
  message: (message: ChatRelaySurfaceMessage) => Promise<void>;
}

export interface ChatRelaySurfaceDeps {
  service: DiscordChatRelayService;
  /** セッション中継 (Lictor relay) に割り当て済みのチャンネル・スレッドか (DCR-INV-02)。 */
  isSessionRelayChannel: (channelId: string) => boolean;
  /** bot 自身のユーザ ID (mentionsBot の判定)。 ready 前は null。 */
  botUserId: () => string | null;
  log: { info: (message: string) => void; warn: (message: string) => void };
}

export function createChatRelaySurface(deps: ChatRelaySurfaceDeps): ChatRelaySurface {
  const routeOf = (message: ChatRelaySurfaceMessage) =>
    deps.service.route(placeOf(message), deps.isSessionRelayChannel);

  return {
    handlesMessage(message) {
      // 人間の発言だけ。 bot 自身・他 bot・webhook・システムメッセージは中継しない (DCR-INV-05)。
      if (message.author.bot || message.webhookId || message.system || !message.guildId) return false;
      const route = routeOf(message);
      if (route.kind === "conflict") {
        deps.log.warn(`discord chat relay target=${route.target.name} failure=session_channel_conflict`);
        return false;
      }
      return route.kind === "relay";
    },

    async message(message) {
      const route = routeOf(message);
      if (route.kind !== "relay" || !message.guildId) return;
      const text = message.content.trim();
      // 添付だけの発言は送らない (受け持ちはするので他の ingress へも回さない)。
      if (text === "") return;
      const botUserId = deps.botUserId();
      const result = await deps.service.forward({
        messageId: message.id,
        guildId: message.guildId,
        channelId: message.channelId,
        parentId: placeOf(message).parentId,
        authorId: message.author.id,
        authorDisplayName: message.member?.displayName ?? message.author.globalName ?? message.author.username,
        text,
        mentionsBot: botUserId !== null && message.mentions.users.has(botUserId),
        sentAt: message.createdAt,
      }, route);
      if (result.kind === "duplicate") {
        deps.log.info(`discord chat relay target=${result.target} skipped=duplicate_message`);
        return;
      }
      if (result.kind === "failed") {
        const status = result.status === null ? "" : ` status=${result.status}`;
        deps.log.warn(`discord chat relay target=${result.target} failure=${result.failure}${status}`);
        return;
      }
      for (const reply of result.replies) {
        try {
          await message.reply({ content: reply.text, allowedMentions: { parse: [], repliedUser: false } });
        } catch {
          deps.log.warn(`discord chat relay target=${result.target} failure=post_failed`);
          return;
        }
      }
    },
  };
}

function placeOf(message: ChatRelaySurfaceMessage): DiscordMessagePlace {
  return message.channel.isThread()
    ? { channelId: message.channelId, parentId: message.channel.parentId ?? null }
    : { channelId: message.channelId, parentId: null };
}
