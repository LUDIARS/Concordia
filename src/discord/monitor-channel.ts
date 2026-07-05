import type { TextChannel } from "discord.js";
import type { MonitorSnapshot } from "../platform/chat-read-model.js";

const MONITOR_MESSAGE_KEY = "monitor_status_message_id";

export interface DiscordDedupStats {
  skipped_chat_posted: number;
  skipped_transcript_frame: number;
  total: number;
}

export interface MonitorOptions {
  stats?: DiscordDedupStats;
}

export async function upsertMonitorChannelMessage(
  channel: TextChannel,
  snapshot: MonitorSnapshot,
  configGet: (k: string) => string | null,
  configSet: (k: string, v: string) => void,
  opts: MonitorOptions = {},
): Promise<void> {
  const lines: string[] = [];
  lines.push("## Concordia Monitor");
  lines.push(`- Status: ${snapshot.activeCount > 0 ? "Active sessions" : "Idle"}`);
  lines.push(`- Active session count: ${snapshot.activeCount}`);
  lines.push(`- Last update: <t:${snapshot.generatedAt}:R>`);
  if (opts.stats) {
    lines.push(
      `- Discord dedup: total=${opts.stats.total} (chat=${opts.stats.skipped_chat_posted}, transcript=${opts.stats.skipped_transcript_frame})`,
    );
  }
  if (snapshot.orgCostLines.length > 0) {
    lines.push("");
    lines.push(...snapshot.orgCostLines);
  }
  lines.push("");
  lines.push(...snapshot.channelCostLines);

  const body = lines.join("\n").slice(0, 3900);
  const msgId = configGet(MONITOR_MESSAGE_KEY);
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
  configSet(MONITOR_MESSAGE_KEY, sent.id);
}
