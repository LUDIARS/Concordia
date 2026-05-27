import type { Guild } from "discord.js";
import { ChannelType } from "discord.js";
import type { DiscordConfigRepo } from "../db/discord-repo.js";
import { META_CHANNEL_KIND, type MetaChannelKind } from "./types.js";

export interface DiscordConfigSnapshot {
  guildId: string;
  metaCategoryId: string;
  sessionsCategoryId: string;
  statusCategoryId: string;
  archiveCategoryId: string;
  costChannelId: string;
  metaChannels: Record<MetaChannelKind, string>;
}

const META_CATEGORY_KEY = "meta_category_id";
const SESSIONS_CATEGORY_KEY = "sessions_category_id";
const STATUS_CATEGORY_KEY = "status_category_id";
const ARCHIVE_CATEGORY_KEY = "archive_category_id";
const COST_CHANNEL_KEY = "cost_channel_id";

const CATEGORY_NAMES = {
  meta: "meta",
  sessions: "sessions",
  status: "状態",
  archive: "archive",
} as const;

const META_CHANNEL_NAMES: Record<MetaChannelKind, string> = {
  chitchat: "chitchat",
  consultation: "consultation",
  houkoku: "houkoku",
  system: "system",
};

export async function ensureDiscordLayout(
  guild: Guild,
  repo: DiscordConfigRepo,
): Promise<DiscordConfigSnapshot> {
  const metaCategoryId = await ensureCategory(guild, repo, META_CATEGORY_KEY, CATEGORY_NAMES.meta);
  const sessionsCategoryId = await ensureCategory(guild, repo, SESSIONS_CATEGORY_KEY, CATEGORY_NAMES.sessions);
  const statusCategoryId = await ensureCategory(guild, repo, STATUS_CATEGORY_KEY, CATEGORY_NAMES.status);
  const archiveCategoryId = await ensureCategory(guild, repo, ARCHIVE_CATEGORY_KEY, CATEGORY_NAMES.archive);
  const costChannelId = await ensureTextChannel(guild, repo, COST_CHANNEL_KEY, "コスト", statusCategoryId);

  const metaChannels: Record<MetaChannelKind, string> = {} as Record<MetaChannelKind, string>;
  for (const k of META_CHANNEL_KIND) {
    metaChannels[k] = await ensureTextChannel(guild, repo, `${k}_channel_id`, META_CHANNEL_NAMES[k], metaCategoryId);
  }

  repo.set("guild_id", guild.id);
  return {
    guildId: guild.id,
    metaCategoryId,
    sessionsCategoryId,
    statusCategoryId,
    archiveCategoryId,
    costChannelId,
    metaChannels,
  };
}

async function ensureCategory(guild: Guild, repo: DiscordConfigRepo, key: string, name: string): Promise<string> {
  const cached = repo.get(key);
  if (cached) {
    const ch = guild.channels.cache.get(cached);
    if (ch?.type === ChannelType.GuildCategory) return cached;
  }
  const existing = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === name);
  if (existing) {
    repo.set(key, existing.id);
    return existing.id;
  }
  const created = await guild.channels.create({ name, type: ChannelType.GuildCategory });
  repo.set(key, created.id);
  return created.id;
}

async function ensureTextChannel(
  guild: Guild,
  repo: DiscordConfigRepo,
  key: string,
  name: string,
  parentId: string,
): Promise<string> {
  const cached = repo.get(key);
  if (cached) {
    const ch = guild.channels.cache.get(cached);
    if (ch && (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement)) return cached;
  }
  const existing = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildText && c.name === name && c.parentId === parentId,
  );
  if (existing) {
    repo.set(key, existing.id);
    return existing.id;
  }
  const created = await guild.channels.create({ name, type: ChannelType.GuildText, parent: parentId });
  repo.set(key, created.id);
  return created.id;
}

