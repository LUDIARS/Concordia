/**
 * 拠点が本社へ送るローカル Claude/Codex の週間使用量 (SPEC-FED-SITE-USAGE) を組み立てる純関数と型。
 *
 * 使用率は cost サンプルの provider 別最新値、 トークンは直近 7 暦日の集計。 サンプルが無い provider は
 * 使用率を null、 そのホストで一度も使っていない provider はトークンも null にして「未観測」と 0 を分ける。
 *
 * @implements spec/feature/federation-link.md SPEC-FED-SITE-USAGE
 */
import { USAGE_PROVIDERS, type FederationUsageProvider } from "./protocol.js";
import type { CostLimitSampleRow } from "../db/cost-limit-samples-repo.js";
import type { ProviderWeeklyTokens } from "../cost/provider-weekly-tokens.js";

export interface SiteUsageReport {
  generated_at: number;
  window_start: number;
  window_end: number;
  providers: FederationUsageProvider[];
}

/** 本社が保持する 1 拠点分の最新報告。 */
export interface SiteUsageEntry {
  site_id: string;
  site_name: string;
  received_at: number;
  report: SiteUsageReport;
}

export function buildSiteUsageReport(
  latestSamples: readonly CostLimitSampleRow[],
  weekly: ProviderWeeklyTokens,
  nowSec: number,
): SiteUsageReport {
  const providers = USAGE_PROVIDERS.map((provider): FederationUsageProvider => {
    const sample = latestSamples.find((row) => row.provider === provider) ?? null;
    const tokens = weekly.tokens.get(provider);
    return {
      provider,
      plan: sample?.plan?.slice(0, 50) ?? null,
      weekly_tokens: tokens === undefined ? (sample ? 0 : null) : Math.max(0, Math.floor(tokens)),
      used_weekly_pct: sample?.used_weekly_pct ?? null,
      reset_weekly_at: sample?.reset_weekly_at ?? null,
      sampled_at: sample?.ts ?? null,
    };
  });
  return { generated_at: nowSec, window_start: weekly.startSec, window_end: weekly.endSec, providers };
}
