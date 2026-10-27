/**
 * 本社のコストチャンネル本文に出す「拠点の週間使用量」節 (SPEC-FED-SITE-USAGE)。
 *
 * 拠点ごとに Claude Code / Codex の週間リミット残・リセット・直近 7 日のトークンを並べる。
 * 報告が途絶えた拠点は値を消さずに古いと分かる印を付ける (最後に分かった値も判断材料になるため)。
 *
 * @implements spec/feature/federation-link.md SPEC-FED-SITE-USAGE
 */
import type { CostTimestampFormat } from "./cost-report.js";
import type { SiteUsageEntry } from "../federation/site-usage.js";

/** 拠点の送信間隔 (15 分) の 4 周期分届かなければ途絶えたとみなす。 */
export const SITE_USAGE_STALE_SEC = 60 * 60;

const PROVIDER_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  "codex-cli": "Codex",
};

export function renderSiteUsageLines(entries: readonly SiteUsageEntry[], fmt: CostTimestampFormat, nowSec: number): string[] {
  if (entries.length === 0) return [];
  const lines = ["### 拠点の週間使用量"];
  for (const entry of entries) {
    const stale = nowSec - entry.received_at > SITE_USAGE_STALE_SEC ? " ⚠️ 報告が途絶えています" : "";
    lines.push(`- 🏢 ${entry.site_name} (報告 ${fmt.at(entry.received_at)})${stale}`);
    for (const p of entry.report.providers) {
      const label = PROVIDER_LABELS[p.provider] ?? p.provider;
      const remain = p.used_weekly_pct === null ? "-" : `${Math.max(0, 100 - p.used_weekly_pct).toFixed(1)}%`;
      const reset = p.reset_weekly_at === null ? "" : ` (リセット ${fmt.at(p.reset_weekly_at)})`;
      const tokens = p.weekly_tokens === null ? "-" : new Intl.NumberFormat("en-US").format(p.weekly_tokens);
      lines.push(`  - ${label}: 週間リミット残 ${remain}${reset} / 7 日 Tokens ${tokens}`);
    }
  }
  return lines;
}
