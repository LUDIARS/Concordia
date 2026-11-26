/**
 * チームのセクションチャンネルの投稿を 1 件 REST で取り直し、 添付を返す (読み取り専用)。
 *
 * Discord の添付 URL は署名付きで期限がある (約 24 時間) ため、 記録時の URL は保存しない。
 * 取り込み (discord-notion-sync) のときにここで投稿を取り直し、 その時点で有効な URL を得る。
 * token は Cc の本社 bot (子会社も同一 token) を live 解決し、 呼び出し側へは渡さない。
 */

import { REST, Routes } from "discord.js";
import type { DiscordMessageAttachmentSource } from "./message-attachments.js";

export interface TeamAttachmentReader {
  /** 投稿の添付。 投稿が無い・id が一致しないときは例外。 */
  readAttachments(channelId: string, messageId: string): Promise<DiscordMessageAttachmentSource[]>;
}

interface RawAttachment {
  id: string;
  filename?: string;
  content_type?: string | null;
  size?: number;
  url: string;
}

interface RawMessage {
  id: string;
  channel_id?: string;
  attachments?: RawAttachment[];
}

export class TeamAttachmentMessageMismatchError extends Error {
  constructor() {
    super("Discord returned a different message than requested");
    this.name = "TeamAttachmentMessageMismatchError";
  }
}

export function createTeamAttachmentReader(deps: { resolveToken: () => string | null }): TeamAttachmentReader {
  return {
    async readAttachments(channelId, messageId) {
      const token = deps.resolveToken();
      if (!token) throw new Error("discord bot token is not configured");
      const rest = new REST({ version: "10" }).setToken(token);
      const message = await rest.get(Routes.channelMessage(channelId, messageId)) as RawMessage;
      if (message.id !== messageId || (message.channel_id !== undefined && message.channel_id !== channelId)) {
        throw new TeamAttachmentMessageMismatchError();
      }
      return (message.attachments ?? []).map((attachment) => ({
        id: attachment.id,
        name: attachment.filename ?? null,
        contentType: attachment.content_type ?? null,
        size: attachment.size ?? 0,
        url: attachment.url,
      }));
    },
  };
}
