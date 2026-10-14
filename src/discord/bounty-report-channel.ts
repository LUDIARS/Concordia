/**
 * バグバウンティの「バグ報告」チャンネル。 カテゴリを持たないチャンネルとして用意し、 権限者への知らせ先
 * (`discord.bounty_authority_channel_id`) が未設定ならこのチャンネルを入れる。
 *
 * @implements spec/feature/bug-bounty.md §17.7 WebUI と権限者 (バグ報告チャンネル)
 *
 * 2026-10-14 neco 指示「カテゴリ内場所に『バグ報告』チャンネルを作ろう」→「バグ報告はトップレベルで良い」。
 * カテゴリに入っていれば起動時に外へ出す (デイリーゴール・雑務課と同じ扱い)。
 */

import { ChannelType, type Guild, type TextChannel } from "discord.js";
import type { DiscordConfigRepo } from "../db/discord-repo.js";

export const BOUNTY_REPORT_CHANNEL_NAME = "バグ報告";
const CHANNEL_CONFIG_KEY = "bounty_report_channel_id";
const AUTHORITY_CONFIG_KEY = "bounty_authority_channel_id";
const TOPIC = "バグバウンティの報告のうち、権限者の判断が要るもの (仕分けの失敗・再審・タスク作成の失敗など) を知らせます。報告は /bug から。";

type ChannelLookup = Pick<Guild["channels"], "cache" | "create">;

/** 保存済みの id、 なければ同名のテキストチャンネルを探す。 */
export function findBountyReportChannel(channels: Pick<ChannelLookup, "cache">, savedId: string | null): TextChannel | null {
  const saved = savedId ? channels.cache.get(savedId) : undefined;
  if (saved?.type === ChannelType.GuildText) return saved;
  const found = [...channels.cache.values()].find((c) => c.type === ChannelType.GuildText && c.name === BOUNTY_REPORT_CHANNEL_NAME);
  return found?.type === ChannelType.GuildText ? found : null;
}

/**
 * チャンネルを用意して id を返す。
 * 権限者の知らせ先は、 未設定のときだけこのチャンネルにする (人が別の場所を設定していれば上書きしない)。
 */
export async function ensureBountyReportChannel(input: {
  guild: { channels: ChannelLookup };
  config: DiscordConfigRepo;
  log: { warn(message: string): void };
}): Promise<string> {
  const { guild, config, log } = input;
  const channel = findBountyReportChannel(guild.channels, config.get(CHANNEL_CONFIG_KEY))
    ?? await guild.channels.create({ name: BOUNTY_REPORT_CHANNEL_NAME, type: ChannelType.GuildText, topic: TOPIC });
  if (channel.parentId) {
    await channel.setParent(null, { reason: "bounty report channel moved out of category" })
      .catch((error) => log.warn(`bounty report channel could not leave its category: ${String(error)}`));
  }
  config.set(CHANNEL_CONFIG_KEY, channel.id);
  if (!config.get(AUTHORITY_CONFIG_KEY)) config.set(AUTHORITY_CONFIG_KEY, channel.id);
  return channel.id;
}
