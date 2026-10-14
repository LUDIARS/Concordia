/**
 * バグバウンティの「バグ報告」チャンネル。 カテゴリ「場所」の中に用意し、 権限者への知らせ先
 * (`discord.bounty_authority_channel_id`) が未設定ならこのチャンネルを入れる。
 *
 * @implements spec/feature/bug-bounty.md §17.7 WebUI と権限者 (バグ報告チャンネル)
 *
 * 2026-10-14 neco 指示「カテゴリ内場所に『バグ報告』チャンネルを作ろう」。
 * カテゴリは人が作るもので、 Cc は作らない。 見つからなければ何も作らずに知らせるだけ
 * (カテゴリ外に作ると、 人が置き場所を直す手間が増える)。
 */

import { ChannelType, type Guild, type GuildBasedChannel, type TextChannel } from "discord.js";
import type { DiscordConfigRepo } from "../db/discord-repo.js";

export const BOUNTY_REPORT_CHANNEL_NAME = "バグ報告";
export const BOUNTY_REPORT_CATEGORY_NAME = "場所";
const CHANNEL_CONFIG_KEY = "bounty_report_channel_id";
const AUTHORITY_CONFIG_KEY = "bounty_authority_channel_id";
const TOPIC = "バグバウンティの報告のうち、権限者の判断が要るもの (仕分けの失敗・再審・タスク作成の失敗など) を知らせます。報告は /bug から。";

type ChannelLookup = Pick<Guild["channels"], "cache" | "create">;

/** 保存済みの id、 なければカテゴリ「場所」の中の同名チャンネルを探す。 */
export function findBountyReportChannel(channels: Pick<ChannelLookup, "cache">, savedId: string | null): TextChannel | null {
  const saved = savedId ? channels.cache.get(savedId) : undefined;
  if (saved?.type === ChannelType.GuildText) return saved;
  const category = findCategory(channels);
  if (!category) return null;
  const found = [...channels.cache.values()].find((c) =>
    c.type === ChannelType.GuildText && c.name === BOUNTY_REPORT_CHANNEL_NAME && c.parentId === category.id);
  return found?.type === ChannelType.GuildText ? found : null;
}

function findCategory(channels: Pick<ChannelLookup, "cache">): GuildBasedChannel | undefined {
  return [...channels.cache.values()].find((c) => c.type === ChannelType.GuildCategory && c.name === BOUNTY_REPORT_CATEGORY_NAME);
}

/**
 * チャンネルを用意して id を返す。 カテゴリが無ければ null。
 * 権限者の知らせ先は、 未設定のときだけこのチャンネルにする (人が別の場所を設定していれば上書きしない)。
 */
export async function ensureBountyReportChannel(input: {
  guild: { channels: ChannelLookup };
  config: DiscordConfigRepo;
  log: { warn(message: string): void };
}): Promise<string | null> {
  const { guild, config, log } = input;
  let channel = findBountyReportChannel(guild.channels, config.get(CHANNEL_CONFIG_KEY));
  if (!channel) {
    const category = findCategory(guild.channels);
    if (!category) {
      log.warn(`bounty report channel not created: category "${BOUNTY_REPORT_CATEGORY_NAME}" was not found`);
      return null;
    }
    channel = await guild.channels.create({
      name: BOUNTY_REPORT_CHANNEL_NAME, type: ChannelType.GuildText, parent: category.id, topic: TOPIC,
    });
  }
  config.set(CHANNEL_CONFIG_KEY, channel.id);
  if (!config.get(AUTHORITY_CONFIG_KEY)) config.set(AUTHORITY_CONFIG_KEY, channel.id);
  return channel.id;
}
