// 共通型. discord.js への依存を最小化するためのインジェクション境界.

import type { ChatChannel } from "../db/chat-repo.js";

export const META_CHANNEL_KIND = [
  "chitchat",
  "consultation",
  "houkoku",
  "system",
] as const;
export type MetaChannelKind = (typeof META_CHANNEL_KIND)[number];

/** ChatChannel ('報告' を含む) ↔ Discord channel kind の往復. */
export function chatChannelToMetaKind(c: ChatChannel): MetaChannelKind | null {
  if (c === "chitchat") return "chitchat";
  if (c === "consultation") return "consultation";
  if (c === "報告") return "houkoku";
  if (c === "system") return "system";
  return null;
}
export function metaKindToChatChannel(k: MetaChannelKind): ChatChannel {
  if (k === "houkoku") return "報告";
  return k;
}

export interface DiscordEnv {
  enabled: boolean;
  token: string | null;
  guildId: string | null;
  applicationId: string | null;
}

export function readDiscordEnv(env: NodeJS.ProcessEnv = process.env): DiscordEnv {
  return {
    enabled: String(env.CONCORDIA_DISCORD_ENABLED ?? "").trim() === "1",
    token: env.CONCORDIA_DISCORD_TOKEN?.trim() || null,
    guildId: env.CONCORDIA_DISCORD_GUILD_ID?.trim() || null,
    applicationId: env.CONCORDIA_DISCORD_APPLICATION_ID?.trim() || null,
  };
}
