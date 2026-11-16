/**
 * 管制チャンネルの Discord 面: 「管制」テキストチャンネルの用意 (ON の間だけ・カテゴリ外)、
 * 人間の投稿の受付と返信、管制の通知の投稿。処理の中身は control-session/channel-service が持つ。
 *
 * @implements spec/feature/control-session.md — 3. 管制チャンネルと側セッション / CC-CTL-INV-03
 */
import { ChannelType, type Guild, type Message, type TextChannel } from "discord.js";
import type { DiscordConfigRepo } from "../db/discord-repo.js";
import type { ControlChannelPost } from "../control-session/channel-service.js";
import type { ControlChannelSurface } from "../control-session/channel-surface.js";

export const CONTROL_CHANNEL_NAME = "管制";
export const CONTROL_CHANNEL_CONFIG_KEY = "control_channel_id";
const CONTROL_CHANNEL_TOPIC = "Cc 管制: 状況の質問はそのまま投稿。多数のセッションへの指示は「一括: 本文」/「一括[Cc,At]: 本文」。";
const DISCORD_LIMIT = 1900;
const noMentions = { parse: [] as never[] };

export interface ControlChannelPort {
  handleChannelPost(post: ControlChannelPost): Promise<string>;
}

export interface ControlChannelDiscord extends ControlChannelSurface {
  handlesMessage(message: Message): boolean;
  message(message: Message): Promise<void>;
  stop(): void;
}

function clip(text: string): string {
  return text.length > DISCORD_LIMIT ? `${text.slice(0, DISCORD_LIMIT - 1)}…` : text;
}

export function createControlChannelDiscord(input: {
  guild: Guild;
  config: DiscordConfigRepo;
  port: ControlChannelPort;
  allowed(userId: string): boolean;
  log: { warn(message: string): void };
}): ControlChannelDiscord {
  let stopped = false;

  function savedChannel(): TextChannel | null {
    const id = input.config.get(CONTROL_CHANNEL_CONFIG_KEY);
    const channel = id ? input.guild.channels.cache.get(id) : null;
    return channel?.type === ChannelType.GuildText ? channel : null;
  }

  return {
    async ensure() {
      if (stopped) return;
      const known = savedChannel() ?? [...input.guild.channels.cache.values()]
        .find((c): c is TextChannel => c.type === ChannelType.GuildText && c.name === CONTROL_CHANNEL_NAME) ?? null;
      const channel = known ?? await input.guild.channels.create({
        name: CONTROL_CHANNEL_NAME, type: ChannelType.GuildText, topic: CONTROL_CHANNEL_TOPIC,
      });
      if (channel.parentId) await channel.setParent(null, { reason: "control channel stays outside categories" });
      if (channel.topic !== CONTROL_CHANNEL_TOPIC) {
        await channel.setTopic(CONTROL_CHANNEL_TOPIC).catch((error) => input.log.warn(`control channel topic update failed: ${String(error)}`));
      }
      input.config.set(CONTROL_CHANNEL_CONFIG_KEY, channel.id);
    },
    async post(text) {
      const channel = savedChannel();
      if (!channel || stopped) return;
      await channel.send({ content: clip(text), allowedMentions: noMentions });
    },
    handlesMessage(message) {
      if (stopped || message.author.bot || message.webhookId) return false;
      const id = input.config.get(CONTROL_CHANNEL_CONFIG_KEY);
      return !!id && message.channelId === id;
    },
    async message(message) {
      const reply = await input.port.handleChannelPost({
        actorLabel: message.member?.displayName ?? message.author.username,
        allowed: input.allowed(message.author.id),
        content: message.content,
      });
      await message.reply({ content: clip(reply), allowedMentions: noMentions });
    },
    stop() {
      stopped = true;
    },
  };
}
