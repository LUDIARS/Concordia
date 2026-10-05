/**
 * 「人間依頼」チャンネル — 分類器に止められて人間が打つしかないコマンドの受け渡し面。
 *
 * Discord はメッセージの一部だけをコピーしにくい (2026-10-05 neco 指示) ので、
 * 1 依頼を次の 3 投稿に分ける:
 *   1. 説明と関連セッション投稿へのリンク
 *   2. コマンドだけ (先頭の `!` は付けない)
 *   3. OK ボタン — 押すと 2 のコマンド投稿を消し、3 を処理済みにする
 *
 * 子会社を含む各 Bot runtime が自 guild に 1 本ずつ持つ。
 *
 * @implements spec/feature/human-request-channel.md
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  type Guild,
  type Interaction,
  type TextChannel,
} from "discord.js";
import type { DiscordConfigRepo } from "../db/discord-repo.js";
import { ensureHumanRequestChannel } from "./config.js";
import { parseHumanCommandRequests, type HumanCommandRequest } from "./human-command-marker.js";

const OK_PREFIX = "human-request:ok:";
/** 同じ session.message の update 再配送で二重投稿しないための記憶数。 */
const SEEN_LIMIT = 500;

export interface HumanRequestDiscord {
  /** canonical session.message (AI 発言) からマーカーを拾って投稿する。 */
  onSessionMessage(input: { sessionId: string; messageId: number; authorType: string; content: string }): Promise<void>;
  handlesInteraction(interaction: Interaction): boolean;
  interaction(interaction: Interaction): Promise<void>;
  stop(): void;
}

export function humanRequestHeader(request: HumanCommandRequest, sessionUrl: string | null): string {
  return [
    "🙋 **人間依頼** — 分類器に止められたコマンドの実行をお願いします。",
    request.description,
    sessionUrl ? `関連セッション: ${sessionUrl}` : "関連セッション: (投稿先を特定できませんでした)",
    "次の投稿のコマンドをコピーしてセッションの端末で実行し、終わったら OK を押してください。",
  ].filter(Boolean).join("\n");
}

export function humanRequestOkRow(commandMessageId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${OK_PREFIX}${commandMessageId}`).setLabel("OK").setStyle(ButtonStyle.Success),
  );
}

export function parseHumanRequestOk(customId: string): string | null {
  const match = /^human-request:ok:([0-9]{17,20})$/.exec(customId);
  return match ? match[1]! : null;
}

export async function startHumanRequestDiscord(input: {
  guild: Guild;
  config: DiscordConfigRepo;
  parentId: string;
  /** セッションの Discord 投稿 (スレッド / チャンネル) の URL。 無ければ null。 */
  sessionUrl: (sessionId: string) => string | null;
  allowed?: (userId: string) => boolean;
  log: { warn(message: string): void };
}): Promise<HumanRequestDiscord> {
  const channelId = await ensureHumanRequestChannel(input.guild, input.config, input.parentId);
  const seen = new Set<number>();
  let stopped = false;

  const channel = async (): Promise<TextChannel | null> => {
    const found = await input.guild.channels.fetch(channelId).catch(() => null);
    return found?.type === ChannelType.GuildText ? found : null;
  };

  const post = async (sessionId: string, request: HumanCommandRequest): Promise<void> => {
    const target = await channel();
    if (!target || stopped) return;
    const none = { parse: [] as [] };
    await target.send({ content: humanRequestHeader(request, input.sessionUrl(sessionId)), allowedMentions: none });
    const commandMessage = await target.send({ content: request.command, allowedMentions: none });
    await target.send({
      content: "実行したら OK を押してください。押すとコマンドの投稿を消します。",
      components: [humanRequestOkRow(commandMessage.id)],
      allowedMentions: none,
    });
  };

  return {
    async onSessionMessage(message) {
      if (stopped || message.authorType !== "assistant" || seen.has(message.messageId)) return;
      const requests = parseHumanCommandRequests(message.content);
      if (requests.length === 0) return;
      seen.add(message.messageId);
      if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value as number);
      for (const request of requests) await post(message.sessionId, request);
    },
    handlesInteraction: (interaction) => interaction.isButton() && interaction.customId.startsWith(OK_PREFIX),
    async interaction(interaction) {
      if (!interaction.isButton() || stopped) return;
      const commandMessageId = parseHumanRequestOk(interaction.customId);
      if (!commandMessageId || interaction.guildId !== input.guild.id || interaction.channelId !== channelId
        || interaction.message.author.id !== input.guild.client.user.id || input.allowed?.(interaction.user.id) === false) {
        await interaction.reply({ content: "この人間依頼を操作する権限がありません。", ephemeral: true });
        return;
      }
      await interaction.deferUpdate();
      const target = await channel();
      // 既に消えている (手動削除・二重押下) なら目的は達成済みとして処理済みにする。
      await target?.messages.delete(commandMessageId).catch(() => undefined);
      await interaction.editReply({ content: `✅ 処理済み (<@${interaction.user.id}>)`, components: [], allowedMentions: { parse: [] } });
    },
    stop() {
      stopped = true;
      seen.clear();
    },
  };
}
