/**
 * コスト本文の「### Gemini」節に足す、Antigravity の利用枠の行 (純関数)。
 * 書式は Codex / Claude Code の節と揃える (残り % とリセット時刻)。
 *
 * @implements spec/feature/cost-observability.md Gemini（Antigravity CLI） C-4
 */
import type { AgyUsage } from "./agy-usage.js";

interface TimestampFormat {
  at(epochSec: number | null): string;
}

export function renderGeminiUsageLines(usage: AgyUsage | null, fmt: TimestampFormat): string[] {
  if (!usage) return ["- 5H リミット残: - (agy /usage 取得失敗)", "- 週間リミット残: -"];
  const lines = [
    `- 5H リミット残: ${remainPct(usage.fiveHour?.usedPct ?? null)}`,
    `- 週間リミット残: ${remainPct(usage.weekly?.usedPct ?? null)}`,
    `- 5H リセット: ${fmt.at(usage.fiveHour?.resetsAtSec ?? null)}`,
    `- 週間リセット: ${fmt.at(usage.weekly?.resetsAtSec ?? null)}`,
  ];
  // モデル別・他社モデルの枠 (Gemini 4 Argon、Claude and GPT models など) は全体枠と別カウントなので併記する。
  for (const row of usage.others) {
    lines.push(`- ${row.group} (${row.label}) 残: ${remainPct(row.usedPct)} (リセット ${fmt.at(row.resetsAtSec)})`);
  }
  return lines;
}

function remainPct(used: number | null): string {
  if (used === null) return "-";
  return `${Math.max(0, Math.min(100, 100 - used)).toFixed(1)}%`;
}
