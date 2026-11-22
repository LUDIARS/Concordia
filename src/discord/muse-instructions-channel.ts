/**
 * 「muse-指令」チャンネル: Muse へ出した指令と、 Muse の受領・回答・再配信を人が見る場所
 * (spec/feature/agent-instructions-bridge.md — 指令チャンネル / CC-INST-INV-08 / INV-09)。
 *
 * 2026-11-23 neco 指示「Museへの指令を見れる場所と、回答を記録するチャンネルを用意する」。
 * カテゴリを持たないトップレベルのチャンネル (バグ報告と同じ作り: 保存済み id → 同名探索 → 無ければ作成、
 * id を discord config に保存、 カテゴリに入っていれば外へ出す)。 本社 Bot だけが用意する。
 *
 * 受領・回答・再配信は登録の投稿への返信にする。 登録の投稿を覚えていない (再起動を跨いだ等) ときは
 * 同じチャンネルへ id 付きで投稿する。 投稿は後追いで、 失敗は中継 (instruction-events.ts) が warn に残す。
 *
 * @implements spec/feature/agent-instructions-bridge.md — 指令チャンネル
 */

import { ChannelType, type Guild, type TextChannel } from "discord.js";
import { buildInstructionPost } from "../agent-instructions/instruction-posts.js";
import type { InstructionEventListener } from "../agent-instructions/instruction-events.js";
import type { DiscordConfigRepo } from "../db/discord-repo.js";

export const MUSE_INSTRUCTIONS_CHANNEL_NAME = "muse-指令";
export const MUSE_INSTRUCTIONS_CHANNEL_CONFIG_KEY = "muse_instructions_channel_id";
const TOPIC = "外部エージェント (Muse / dots) へ出した指令と、受領・回答を記録します。一覧は Web の「Muse 指令」。ここへの投稿は指令になりません。";
/** 返信先として覚えておく登録の投稿の数。 古いものから忘れる。 */
export const MUSE_INSTRUCTIONS_TRACKED_POSTS = 500;
const noMentions = { parse: [] as never[] };

type ChannelLookup = Pick<Guild["channels"], "cache" | "create">;

/** 投稿に要る口だけ (テストで差し替える)。 */
export interface InstructionPostChannel {
  send(options: {
    content: string;
    allowedMentions: { parse: never[] };
    reply?: { messageReference: string; failIfNotExists: boolean };
  }): Promise<{ id: string }>;
}

/** 保存済みの id、 なければ同名のテキストチャンネルを探す。 */
export function findMuseInstructionsChannel(channels: Pick<ChannelLookup, "cache">, savedId: string | null): TextChannel | null {
  const saved = savedId ? channels.cache.get(savedId) : undefined;
  if (saved?.type === ChannelType.GuildText) return saved;
  const found = [...channels.cache.values()].find((c) => c.type === ChannelType.GuildText && c.name === MUSE_INSTRUCTIONS_CHANNEL_NAME);
  return found?.type === ChannelType.GuildText ? found : null;
}

export async function ensureMuseInstructionsChannel(input: {
  guild: { channels: ChannelLookup };
  config: DiscordConfigRepo;
  log: { warn(message: string): void };
}): Promise<TextChannel> {
  const { guild, config, log } = input;
  const channel = findMuseInstructionsChannel(guild.channels, config.get(MUSE_INSTRUCTIONS_CHANNEL_CONFIG_KEY))
    ?? await guild.channels.create({ name: MUSE_INSTRUCTIONS_CHANNEL_NAME, type: ChannelType.GuildText, topic: TOPIC });
  if (channel.parentId) {
    await channel.setParent(null, { reason: "muse instructions channel stays outside categories" })
      .catch((error) => log.warn(`muse instructions channel could not leave its category: ${String(error)}`));
  }
  config.set(MUSE_INSTRUCTIONS_CHANNEL_CONFIG_KEY, channel.id);
  return channel;
}

/** 指令の出来事をチャンネルへ投稿する受け手。 */
export function createMuseInstructionsPoster(channel: InstructionPostChannel, tracked = MUSE_INSTRUCTIONS_TRACKED_POSTS): InstructionEventListener {
  const posts = new Map<string, string>();
  return async (event) => {
    const post = buildInstructionPost(event);
    const reference = post.replyTo ? posts.get(post.replyTo) : undefined;
    const sent = await channel.send({
      content: post.content,
      allowedMentions: noMentions,
      ...(reference ? { reply: { messageReference: reference, failIfNotExists: false } } : {}),
    });
    if (event.kind !== "registered") return;
    posts.set(event.id, sent.id);
    while (posts.size > tracked) {
      const oldest = posts.keys().next().value;
      if (oldest === undefined) break;
      posts.delete(oldest);
    }
  };
}
