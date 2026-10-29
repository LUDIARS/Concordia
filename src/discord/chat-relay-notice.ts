/**
 * Discord チャット中継のお知らせ面 (spec/feature/discord-chat-relay.md §お知らせチャンネル、 DCR-INV-13〜15)。
 *
 * chat-relay-surface.ts から、 お知らせのチャンネルの bot / webhook の投稿を受け持つと決めた後に呼ばれる。
 * 投稿の本文と埋め込みの文字部分だけを取り出して中継サービスへ渡し、 返事を元の投稿への reply として投稿し、
 * LINE への push の結果を件数と status だけでログに残す (本文・宛先・トークンは出さない)。
 *
 * @implements spec/feature/discord-chat-relay.md — お知らせチャンネル
 */

import type { DiscordChatRelayService } from "../discord-chat-relay/relay-service.js";
import type { DiscordNoticeEmbed } from "../discord-chat-relay/notice.js";
import { hasNoticeContent } from "../discord-chat-relay/notice.js";
import type { DiscordChatRoute } from "../discord-chat-relay/routing.js";
import type { LineNoticePushReport } from "../line-webhook/notice-push.js";

/** discord.js の Embed のうち文字部分。 画像・サムネイル・URL は読まない。 */
export interface ChatRelayNoticeEmbedSource {
  title?: string | null;
  description?: string | null;
  fields?: ReadonlyArray<{ name: string; value: string }>;
}

export interface ChatRelayNoticeMessage {
  id: string;
  guildId: string | null;
  content: string;
  webhookId: string | null;
  createdAt: Date;
  author: { id: string; username: string; globalName?: string | null };
  member?: { displayName: string } | null;
  embeds?: readonly ChatRelayNoticeEmbedSource[];
  reply(options: { content: string; allowedMentions: { parse: []; repliedUser: boolean } }): Promise<unknown>;
}

export interface ChatRelayNoticeDeps {
  service: DiscordChatRelayService;
  log: { info: (message: string) => void; warn: (message: string) => void };
}

export async function relayDiscordNotice(
  deps: ChatRelayNoticeDeps,
  message: ChatRelayNoticeMessage,
  route: Extract<DiscordChatRoute, { kind: "relay" }>,
): Promise<void> {
  if (!message.guildId) return;
  const notice = {
    messageId: message.id,
    guildId: message.guildId,
    authorId: message.author.id,
    authorDisplayName: message.member?.displayName ?? message.author.globalName ?? message.author.username,
    webhookId: message.webhookId,
    text: message.content.trim(),
    embeds: (message.embeds ?? []).map(embedText),
    sentAt: message.createdAt,
  };
  // 本文も埋め込みの文字も無い投稿は送らない (受け持ちはするので他の ingress へも回さない)。
  if (!hasNoticeContent(notice)) return;
  const result = await deps.service.forwardNotice(notice, route);
  if (result.kind === "duplicate") {
    deps.log.info(`discord chat relay target=${result.target} kind=notice skipped=duplicate_message`);
    return;
  }
  if (result.kind === "failed") {
    const status = result.status === null ? "" : ` status=${result.status}`;
    deps.log.warn(`discord chat relay target=${result.target} kind=notice failure=${result.failure}${status}`);
    return;
  }
  if (result.linePush) logLinePush(deps, result.target, result.linePush);
  for (const reply of result.replies) {
    try {
      await message.reply({ content: reply.text, allowedMentions: { parse: [], repliedUser: false } });
    } catch {
      deps.log.warn(`discord chat relay target=${result.target} kind=notice failure=post_failed`);
      return;
    }
  }
}

function embedText(embed: ChatRelayNoticeEmbedSource): DiscordNoticeEmbed {
  return {
    title: embed.title ?? null,
    description: embed.description ?? null,
    fields: (embed.fields ?? []).map((field) => ({ name: field.name, value: field.value })),
  };
}

/** 件数と status だけ (LINE-WH-INV-30)。 429 は無料枠の月間上限として名前を付ける。 */
function logLinePush(deps: ChatRelayNoticeDeps, target: string, report: LineNoticePushReport): void {
  if (report.kind === "skipped") {
    deps.log.info(`discord chat relay target=${target} line_push=skipped reason=${report.reason}`);
    return;
  }
  const line = `discord chat relay target=${target} line_push talks=${report.talks} sent=${report.sent}`;
  if (report.failedStatuses.length === 0) {
    deps.log.info(line);
    return;
  }
  const statuses = report.failedStatuses
    .map((status) => (status === 429 ? "429(monthly_limit)" : status === null ? "unreachable" : String(status)))
    .join(",");
  deps.log.warn(`${line} failed=${report.failedStatuses.length} statuses=${statuses}`);
}
