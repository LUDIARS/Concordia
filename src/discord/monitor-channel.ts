import type { TextChannel } from "discord.js";
import type { SessionsRepo } from "../db/sessions-repo.js";

const MONITOR_MESSAGE_KEY = "monitor_status_message_id";

// concordia-monitor チャンネルに、アクティブなセッション数と最終更新時間を
// 1 枚のカード (1 メッセージ) として保つ。cost-channel と同じ edit-or-send 方式。
export async function upsertMonitorChannelMessage(
  channel: TextChannel,
  sessionsRepo: SessionsRepo,
  configGet: (k: string) => string | null,
  configSet: (k: string, v: string) => void,
): Promise<void> {
  const active = sessionsRepo.listSessions({ status: "active" });

  const lines: string[] = [];
  lines.push("## Concordia Monitor");
  lines.push(`- 状態: ${active.length > 0 ? "🟢 アクティブ" : "⚪ アイドル"}`);
  lines.push(`- アクティブなセッション数: ${active.length}`);
  lines.push(`- 最終更新: <t:${Math.floor(Date.now() / 1000)}:R>`);
  if (active.length > 0) {
    lines.push("");
    for (const s of active.slice(0, 15)) {
      lines.push(`- \`${s.id.slice(0, 8)}\` (${s.provider})${s.current_task ? ` — ${s.current_task}` : ""}`);
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
