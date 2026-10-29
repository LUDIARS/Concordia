/**
 * お知らせチャンネルの拾い分けと転送本文 (spec/feature/discord-chat-relay.md §お知らせチャンネル、 DCR-INV-13 / 14)。
 *
 * Discord に依存しない。 お知らせは外部サービス (おおぞらバス等) の bot / webhook の投稿で、
 * 人の発言の転送 (payload.ts) と同じ版 1 に `kind: "notice"` を足して送る。
 *
 * @implements spec/feature/discord-chat-relay.md — お知らせチャンネル
 */

import { contract } from './ontime-runtime.js'; /* augur-inject:import:63012916 */
import augurContract_05a0b3e7 from './notice.contract.js'; /* augur-inject:contract-predicate:eeb01dd2 */

/** 投稿者のうち、 お知らせかどうかの判定に使う部分。 */
export interface DiscordNoticeAuthorFacts {
  authorId: string;
  authorIsBot: boolean;
  webhookId: string | null;
  system: boolean;
}

/** 埋め込みの文字部分だけ (画像・サムネイル・URL は持たない)。 */
export interface DiscordNoticeEmbed {
  title: string | null;
  description: string | null;
  fields: Array<{ name: string; value: string }>;
}

/** Discord の投稿からお知らせの中継に要る分だけを取り出した形。 */
export interface DiscordNoticeMessage {
  messageId: string;
  guildId: string;
  authorId: string;
  authorDisplayName: string;
  webhookId: string | null;
  text: string;
  embeds: DiscordNoticeEmbed[];
  sentAt: Date;
}

export interface DiscordNoticePayload {
  version: 1;
  kind: "notice";
  messageId: string;
  channelId: string;
  threadId: string | null;
  guildId: string;
  author: { id: string; displayName: string; bot: true; webhookId: string | null };
  text: string;
  embeds: DiscordNoticeEmbed[];
  sentAt: string;
}

/**
 * bot / webhook の投稿だけをお知らせとして拾う。 人の発言・システムメッセージ・Cc 自身の bot の投稿は拾わない
 * (Cc の返事を自分で拾い直して転送を繰り返さないため)。 selfBotUserId が分からない (ready 前) ときは拾わない。
 */
export function isDiscordNoticeAuthor(facts: DiscordNoticeAuthorFacts, selfBotUserId: string | null): boolean {
  if (facts.system || selfBotUserId === null) return false;
  if (!facts.authorIsBot && facts.webhookId === null) return false;
  return facts.authorId !== selfBotUserId;
}
// @ts-expect-error augur-inject
isDiscordNoticeAuthor = contract(isDiscordNoticeAuthor, { ...augurContract_05a0b3e7, contractId: 'dcr-C-7', mode: 'observe', sample: 1, where: 'src/discord-chat-relay/notice.ts:54', rule: 'contract-wrap', id: '05a0b3e7' }); /* augur-inject:contract-wrap:05a0b3e7 */

/** 本文も埋め込みの文字も無い投稿は送らない。 */
export function hasNoticeContent(message: Pick<DiscordNoticeMessage, "text" | "embeds">): boolean {
  if (message.text.trim() !== "") return true;
  return message.embeds.some((embed) =>
    !!embed.title?.trim() || !!embed.description?.trim()
    || embed.fields.some((field) => field.name.trim() !== "" || field.value.trim() !== ""));
}

/** channelId / threadId は振り分け (routing.ts の routeDiscordNotice) の結果を使う。 */
export function buildDiscordNoticePayload(
  message: DiscordNoticeMessage,
  route: { channelId: string; threadId: string | null },
): DiscordNoticePayload {
  return {
    version: 1,
    kind: "notice",
    messageId: message.messageId,
    channelId: route.channelId,
    threadId: route.threadId,
    guildId: message.guildId,
    author: { id: message.authorId, displayName: message.authorDisplayName, bot: true, webhookId: message.webhookId },
    text: message.text,
    embeds: message.embeds.map((embed) => ({
      title: embed.title,
      description: embed.description,
      fields: embed.fields.map((field) => ({ name: field.name, value: field.value })),
    })),
    sentAt: message.sentAt.toISOString(),
  };
}
