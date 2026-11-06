import type { MonitorSnapshot } from "../platform/chat-read-model.js";

const safe = (s: string): string => s.replace(/[\r\n]+/g, " ").replace(/([\\`*_~|<>\[\]])/g, "\\$1");

export function renderMonitor(snapshot: MonitorSnapshot, stats?: { total: number; skipped_chat_posted: number; skipped_transcript_frame: number }): string {
  return renderMonitorPages(snapshot, stats)[0];
}

/** Each page retains its own delivery identity across refreshes. */
export function renderMonitorPages(snapshot: MonitorSnapshot, stats?: { total: number; skipped_chat_posted: number; skipped_transcript_frame: number }): string[] {
  const lines = ["## Concordia Monitor", `- Status: ${snapshot.activeCount > 0 ? "Active sessions" : "Idle"}`, `- Active session count: ${snapshot.activeCount}`,
    `- Last update: <t:${snapshot.generatedAt}:R>`];
  if (stats) lines.push(`- Discord dedup: total=${stats.total} (chat=${stats.skipped_chat_posted}, transcript=${stats.skipped_transcript_frame})`);
  for (const row of snapshot.sessions ?? []) {
    lines.push(`- <#${row.channelId}> · ${safe(row.task ?? "作業未確認").slice(0, 180)} · ${row.progress ? `${row.progress.percent}% (概算)` : "進捗未確認"} · G&G: ${safe(row.goalAndGo)}`);
    if (row.progress) lines.push(`  根拠: ${safe(row.progress.evidence).slice(0, 220)} · <t:${Math.floor(Date.parse(row.progress.at) / 1000)}:R>`);
  }
  lines.push(...snapshot.orgCostLines, ...snapshot.channelCostLines);
  const pages: string[] = [];
  let kept: string[] = [];
  let size = 0;
  for (const line of lines) {
    const bounded = line.slice(0, 1800);
    if (size + bounded.length + 1 > 1850) { pages.push(kept.join("\n")); kept = []; size = 0; }
    kept.push(bounded); size += bounded.length + 1;
  }
  if (kept.length) pages.push(kept.join("\n"));
  return pages;
}
