import type { TextChannel } from "discord.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { DiscordSessionChannelsRepo } from "../db/discord-repo.js";
import { collectOrgCostWindows, renderOrgCostLines, type OrgCostSubsidiary } from "../cost/org-cost.js";
import { cachedSessionWindowReader } from "../cost/windowed-usage-cache.js";
import { collectChannelCostRows, renderChannelCostLines } from "../cost/channel-cost.js";

const MONITOR_MESSAGE_KEY = "monitor_status_message_id";

export interface DiscordDedupStats {
  skipped_chat_posted: number;
  skipped_transcript_frame: number;
  total: number;
}

export interface MonitorOptions {
  stats?: DiscordDedupStats;
  /**
   * 本社 / 子会社別コスト (本日トークン) を出すための子会社一覧。 本社モニターのときだけ渡す
   * (子会社モニターに渡すと他子会社の数字が漏れるので渡さない)。 undefined ならコスト節は出さない。
   */
  costSubsidiaries?: OrgCostSubsidiary[];
}

export async function upsertMonitorChannelMessage(
  channel: TextChannel,
  sessionsRepo: SessionsRepo,
  sessionChannelsRepo: DiscordSessionChannelsRepo,
  configGet: (k: string) => string | null,
  configSet: (k: string, v: string) => void,
  opts: MonitorOptions = {},
): Promise<void> {
  const { stats, costSubsidiaries } = opts;
  const active = sessionsRepo.listSessions({ status: "active" });

  const lines: string[] = [];
  lines.push("## Concordia Monitor");
  lines.push(`- Status: ${active.length > 0 ? "Active sessions" : "Idle"}`);
  lines.push(`- Active session count: ${active.length}`);
  lines.push(`- Last update: <t:${Math.floor(Date.now() / 1000)}:R>`);
  if (stats) {
    lines.push(
      `- Discord dedup: total=${stats.total} (chat=${stats.skipped_chat_posted}, transcript=${stats.skipped_transcript_frame})`,
    );
  }

  // 本社 / 子会社別のコスト (本日 + 週間、 時間帯集計、 本社モニターのみ)。
  if (costSubsidiaries) {
    lines.push("");
    // /v1/cost/overview と同じ memo 化 reader を共有 (同期 I/O でイベントループを塞がない)。
    lines.push(...renderOrgCostLines(collectOrgCostWindows(sessionsRepo, costSubsidiaries, Date.now(), cachedSessionWindowReader)));
  }

  // Lictor の近況 (current_task 一覧) は出さず、 チャンネルごとの「コンテキストの重さ + コスト」を出す。
  // session_id → channel_id は session_channels テーブル (scope 付き) で引く。
  const channelOf = (sessionId: string): string | null =>
    sessionChannelsRepo.findBySessionId(sessionId)?.channel_id ?? null;
  const channelRows = collectChannelCostRows(active, channelOf);
  lines.push("");
  lines.push(...renderChannelCostLines(channelRows));

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
