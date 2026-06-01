import type { TextChannel } from "discord.js";
import type { PrRecordsRepo } from "../db/pr-records-repo.js";
import type { DiscordSessionChannelsRepo } from "../db/discord-repo.js";
import { buildPrQueue } from "../pr/queue.js";
import { renderPrQueueMarkdown } from "../pr/render.js";

const PR_QUEUE_MESSAGE_KEY = "pr_queue_status_message_id";

/**
 * pr-queue チャンネルの単一メッセージを upsert する (monitor-channel と同じ方式).
 * message_id を discord_config に保存し、 次回以降は edit で更新する.
 *
 * 各 PR には「担当セッションの Discord チャンネル」 への mention (`<#channelId>`) を
 * 付ける: author_session_id → discord_session_channels で channel_id を解決する。
 * 終了済 (status=ended、 channel 削除済) は付けない。
 */
export async function upsertPrQueueChannelMessage(
  channel: TextChannel,
  prs: PrRecordsRepo,
  sessionChannels: DiscordSessionChannelsRepo,
  configGet: (k: string) => string | null,
  configSet: (k: string, v: string) => void,
): Promise<void> {
  const queue = buildPrQueue(prs);
  const body = renderPrQueueMarkdown(queue, {
    mentionFor: (row) => {
      if (!row.author_session_id) return null;
      const ch = sessionChannels.findBySessionId(row.author_session_id);
      // 終了済セッションは会話チャンネルが削除されているので mention しない.
      if (!ch || ch.status === "ended") return null;
      return `<#${ch.channel_id}>`;
    },
  }).slice(0, 3900);

  const msgId = configGet(PR_QUEUE_MESSAGE_KEY);
  try {
    if (msgId) {
      const msg = await channel.messages.fetch(msgId);
      await msg.edit({ content: body });
      return;
    }
  } catch {
    // fall through and recreate
  }
  const sent = await channel.send({ content: body });
  configSet(PR_QUEUE_MESSAGE_KEY, sent.id);
}
