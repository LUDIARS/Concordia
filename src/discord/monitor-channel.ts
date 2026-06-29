import type { TextChannel } from "discord.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { SessionTaskRecordsRepo } from "../db/session-task-records-repo.js";
import { collectOrgCostWindows, renderOrgCostLines, type OrgCostSubsidiary } from "../cost/org-cost.js";

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
  sessionTaskRecordsRepo: SessionTaskRecordsRepo,
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
    lines.push(...renderOrgCostLines(collectOrgCostWindows(sessionsRepo, costSubsidiaries)));
  }
  if (active.length > 0) {
    lines.push("");
    for (const s of active.slice(0, 15)) {
      lines.push(`- \`${s.id.slice(0, 8)}\` (${s.provider})${s.current_task ? ` - ${s.current_task}` : ""}`);
    }

    const activeIds = new Set(active.map((s) => s.id));
    const titles: string[] = [];
    for (const s of active) {
      const rows = sessionTaskRecordsRepo
        .listBySession(s.id)
        .filter((t) => t.status !== "completed")
        .slice(0, 5);
      for (const r of rows) {
        if (!activeIds.has(r.session_id)) continue;
        titles.push(r.task_text);
      }
    }
    if (titles.length > 0) {
      lines.push("");
      lines.push("### Open Task Titles");
      for (const t of titles.slice(0, 20)) {
        lines.push(`- ${t.slice(0, 140)}`);
      }
      if (titles.length > 20) lines.push(`- ...and ${titles.length - 20} more`);
    }
  }
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
