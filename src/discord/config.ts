// guild / category / meta channel の idempotent setup。
//
// 起動時に 1 度呼ばれる. 既知の設定が DB に無ければ Discord 上で作成し、
// その ID を `discord_config` に永続. その後の参照はすべて DB 経由.
//
// Meta channel は 4 つ: chitchat / consultation / houkoku / system.
// Category は 3 つ: 'メタ' / 'セッション' / 'アーカイブ'.

import type { Guild } from "discord.js";
import { ChannelType } from "discord.js";
import type { DiscordConfigRepo } from "../db/discord-repo.js";
import { META_CHANNEL_KIND, type MetaChannelKind } from "./types.js";

export interface DiscordConfigSnapshot {
  guildId: string;
  metaCategoryId: string;
  sessionsCategoryId: string;
  archiveCategoryId: string;
  metaChannels: Record<MetaChannelKind, string>;
}

const META_CATEGORY_KEY = "meta_category_id";
const SESSIONS_CATEGORY_KEY = "sessions_category_id";
const ARCHIVE_CATEGORY_KEY = "archive_category_id";

const CATEGORY_NAMES = {
  meta: "🗂 メタ",
  sessions: "🟢 セッション",
  archive: "🗄 アーカイブ",
} as const;

const META_CHANNEL_NAMES: Record<MetaChannelKind, string> = {
  chitchat: "chitchat",
  consultation: "consultation",
  houkoku: "houkoku",
  system: "system",
};

/** 起動時に呼ぶ. category と meta channel を idempotent に揃え、 ID を DB に保存. */
export async function ensureDiscordLayout(
  guild: Guild,
  repo: DiscordConfigRepo,
): Promise<DiscordConfigSnapshot> {
  const metaCategoryId = await ensureCategory(guild, repo, META_CATEGORY_KEY, CATEGORY_NAMES.meta);
  const sessionsCategoryId = await ensureCategory(guild, repo, SESSIONS_CATEGORY_KEY, CATEGORY_NAMES.sessions);
  const archiveCategoryId = await ensureCategory(guild, repo, ARCHIVE_CATEGORY_KEY, CATEGORY_NAMES.archive);

  const metaChannels: Record<MetaChannelKind, string> = {} as Record<MetaChannelKind, string>;
  for (const k of META_CHANNEL_KIND) {
    metaChannels[k] = await ensureMetaChannel(guild, repo, k, metaCategoryId);
  }

  repo.set("guild_id", guild.id);

  return {
    guildId: guild.id,
    metaCategoryId,
    sessionsCategoryId,
    archiveCategoryId,
    metaChannels,
  };
}

async function ensureCategory(
  guild: Guild,
  repo: DiscordConfigRepo,
  key: string,
  name: string,
): Promise<string> {
  const cached = repo.get(key);
  if (cached) {
    const ch = guild.channels.cache.get(cached);
    if (ch?.type === ChannelType.GuildCategory) return cached;
    // DB は持ってるが Discord 上に無い → 再作成して上書き保存
  }
  // 同名既存をまず探す (手作業で既に作ってある場合に被らないため)
  const existing = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildCategory && c.name === name,
  );
  if (existing) {
    repo.set(key, existing.id);
    return existing.id;
  }
  const created = await guild.channels.create({
    name,
    type: ChannelType.GuildCategory,
  });
  repo.set(key, created.id);
  return created.id;
}

async function ensureMetaChannel(
  guild: Guild,
  repo: DiscordConfigRepo,
  kind: MetaChannelKind,
  parentId: string,
): Promise<string> {
  const key = `${kind}_channel_id`;
  const cached = repo.get(key);
  if (cached) {
    const ch = guild.channels.cache.get(cached);
    if (ch && (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement)) {
      return cached;
    }
  }
  const name = META_CHANNEL_NAMES[kind];
  const existing = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildText && c.name === name && c.parentId === parentId,
  );
  if (existing) {
    repo.set(key, existing.id);
    return existing.id;
  }
  const created = await guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: parentId,
  });
  repo.set(key, created.id);
  return created.id;
}
