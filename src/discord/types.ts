// 共通型. discord.js への依存を最小化するためのインジェクション境界.

import type { ChatChannel } from "../db/chat-repo.js";

export const META_CHANNEL_KIND = [
  "chitchat",
  "consultation",
  "houkoku",
  "boyaki",
  "system",
] as const;
export type MetaChannelKind = (typeof META_CHANNEL_KIND)[number];

/** ChatChannel ('報告' / 'ぼやき' を含む) ↔ Discord channel kind の往復. */
export function chatChannelToMetaKind(c: ChatChannel): MetaChannelKind | null {
  if (c === "chitchat") return "chitchat";
  if (c === "consultation") return "consultation";
  if (c === "報告") return "houkoku";
  if (c === "ぼやき") return "boyaki";
  if (c === "system") return "system";
  return null;
}
export function metaKindToChatChannel(k: MetaChannelKind): ChatChannel {
  if (k === "houkoku") return "報告";
  if (k === "boyaki") return "ぼやき";
  return k;
}

export interface DiscordEnv {
  enabled: boolean;
  token: string | null;
  guildId: string | null;
  applicationId: string | null;
  permissionRequestsEnabled: boolean;
  messageOptimizationEnabled: boolean;
  forumMode?: boolean;
}

export function readDiscordEnv(env: NodeJS.ProcessEnv = process.env): DiscordEnv {
  return {
    enabled: String(env.CONCORDIA_DISCORD_ENABLED ?? "").trim() === "1",
    token: env.CONCORDIA_DISCORD_TOKEN?.trim() || null,
    guildId: env.CONCORDIA_DISCORD_GUILD_ID?.trim() || null,
    applicationId: env.CONCORDIA_DISCORD_APPLICATION_ID?.trim() || null,
    permissionRequestsEnabled: envFlag(env.CONCORDIA_DISCORD_PERMISSION_REQUESTS_ENABLED, false),
    messageOptimizationEnabled: envFlag(env.CONCORDIA_DISCORD_MESSAGE_OPTIMIZATION_ENABLED, true),
    forumMode: envFlag(env.CONCORDIA_DISCORD_FORUM_MODE, true),
  };
}

function envFlag(raw: string | undefined, fallback: boolean): boolean {
  const value = raw?.trim().toLowerCase();
  if (!value) return fallback;
  if (value === "1" || value === "true" || value === "on" || value === "yes") return true;
  if (value === "0" || value === "false" || value === "off" || value === "no") return false;
  return fallback;
}
