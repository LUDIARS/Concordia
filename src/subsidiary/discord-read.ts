/**
 * 子会社 Discord の読み取り (2026-09-01 neco 指示)。
 *
 * 子会社 guild のチャンネル一覧とメッセージ履歴を REST で読む。 用途は
 * 調査・作業把握・ディレクターワークフローで、 **チームの有無と無関係に**
 * 子会社行 (guild_id) さえあれば使える。 Bot の Gateway 稼働にも依存しない
 * (本社 token での REST 読み取りのみ、書き込みはしない)。
 *
 * 本社側からの指示で読む経路は /v1/subsidiaries/:id/discord/* (api/subsidiary.ts) が
 * 提供する — loopback 信頼境界なので本社のセッション / delegation からも叩ける。
 */

import { REST, Routes } from "discord.js";

export interface SubsidiaryDiscordReadDeps {
  /** 本社 Discord bot token を live 解決する (子会社は本社と同一 token)。 */
  resolveToken: () => string | null;
}

export interface DiscordChannelSummary {
  id: string;
  name: string;
  type: number;
  parent_id: string | null;
}

export interface DiscordMessageSummary {
  id: string;
  author_id: string;
  author_name: string;
  bot: boolean;
  ts: string;
  content: string;
  attachment_count: number;
}

export interface SubsidiaryDiscordReader {
  listChannels(guildId: string): Promise<DiscordChannelSummary[]>;
  readMessages(
    guildId: string,
    channelId: string,
    opts?: { limit?: number; before?: string },
  ): Promise<DiscordMessageSummary[]>;
}

export class DiscordChannelGuildMismatchError extends Error {
  constructor() {
    super("Discord channel is outside the configured subsidiary guild");
    this.name = "DiscordChannelGuildMismatchError";
  }
}

interface RawChannel {
  id: string;
  name?: string;
  type: number;
  parent_id?: string | null;
  guild_id?: string;
}

interface RawMessage {
  id: string;
  author?: { id: string; username?: string; global_name?: string | null; bot?: boolean };
  timestamp: string;
  content?: string;
  attachments?: unknown[];
}

export function createSubsidiaryDiscordReader(deps: SubsidiaryDiscordReadDeps): SubsidiaryDiscordReader {
  function restOrThrow(): REST {
    const token = deps.resolveToken();
    if (!token) throw new Error("discord bot token is not configured");
    return new REST({ version: "10" }).setToken(token);
  }

  return {
    async listChannels(guildId: string): Promise<DiscordChannelSummary[]> {
      const rest = restOrThrow();
      const channels = await rest.get(Routes.guildChannels(guildId)) as RawChannel[];
      return channels.map((channel) => ({
        id: channel.id,
        name: channel.name ?? "",
        type: channel.type,
        parent_id: channel.parent_id ?? null,
      }));
    },

    async readMessages(guildId, channelId, opts = {}): Promise<DiscordMessageSummary[]> {
      const rest = restOrThrow();
      // チャンネルの guild 所属を必ず照合する — 子会社 API 経由で他 guild (本社含む) の
      // チャンネルを読ませない (id 直指定のクロス guild 読み出し防止)。
      const channel = await rest.get(Routes.channel(channelId)) as RawChannel;
      if (channel.guild_id !== guildId) {
        throw new DiscordChannelGuildMismatchError();
      }
      const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
      const query = new URLSearchParams({ limit: String(limit) });
      if (opts.before) query.set("before", opts.before);
      const messages = await rest.get(Routes.channelMessages(channelId), { query }) as RawMessage[];
      // Discord は新しい順で返す。読み物としては古い順が扱いやすいので反転する。
      return messages.reverse().map((message) => ({
        id: message.id,
        author_id: message.author?.id ?? "",
        author_name: message.author?.global_name || message.author?.username || "",
        bot: message.author?.bot ?? false,
        ts: message.timestamp,
        content: message.content ?? "",
        attachment_count: message.attachments?.length ?? 0,
      }));
    },
  };
}
