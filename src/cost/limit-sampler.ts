import type { CostLimitSampleInput, CostLimitSampleRow } from "../db/cost-limit-samples-repo.js";
import type { CostReport } from "./cost-report.js";

export interface LimitTimeseriesPoint {
  ts: number;
  provider: string;
  plan: string | null;
  used5hPct: number | null;
  usedWeeklyPct: number | null;
  reset5hAt: number | null;
  resetWeeklyAt: number | null;
}

export interface LimitTimeseries {
  points: LimitTimeseriesPoint[];
  providers: Record<string, LimitTimeseriesPoint[]>;
}

export function collectLimitSamples(
  report: CostReport,
  nowSec: number,
): CostLimitSampleInput[] {
  const samples: CostLimitSampleInput[] = [];
  const codexSample = observedOnly({
      ts: nowSec,
      provider: "codex-cli",
      plan: report.codexRate.plan,
      used_5h_pct: report.codexRate.used5h,
      used_weekly_pct: report.codexRate.usedWeekly,
      reset_5h_at: report.codexRate.reset5hAt,
      reset_weekly_at: report.codexRate.resetWeeklyAt,
    });
  if (codexSample) samples.push(codexSample);

  const claudeSample = observedOnly(
    {
      ts: nowSec,
      provider: "claude-code",
      plan: report.claudeUsage?.plan ?? null,
      used_5h_pct: report.claudeUsage?.fiveHour?.utilization ?? null,
      used_weekly_pct: report.claudeUsage?.sevenDay?.utilization ?? null,
      reset_5h_at: report.claudeUsage?.fiveHour?.resetsAtSec ?? null,
      reset_weekly_at: report.claudeUsage?.sevenDay?.resetsAtSec ?? null,
    });
  if (claudeSample) samples.push(claudeSample);
  return samples;
}

export function aggregateLimitTimeseries(rows: CostLimitSampleRow[]): LimitTimeseries {
  const points = rows.map(toPoint);
  const providers: Record<string, LimitTimeseriesPoint[]> = {};
  for (const p of points) {
    const arr = providers[p.provider];
    if (arr) arr.push(p);
    else providers[p.provider] = [p];
  }
  for (const rows of Object.values(providers)) rows.sort((a, b) => a.ts - b.ts);
  return { points, providers };
}

function toPoint(r: CostLimitSampleRow): LimitTimeseriesPoint {
  return {
    ts: r.ts,
    provider: r.provider,
    plan: r.plan,
    used5hPct: r.used_5h_pct,
    usedWeeklyPct: r.used_weekly_pct,
    reset5hAt: r.reset_5h_at,
    resetWeeklyAt: r.reset_weekly_at,
  };
}

function hasLimitValue(a: number | null, b: number | null): boolean {
  return a !== null || b !== null;
}

/**
 * 観測できた値だけを記録する。 欠けている枠は履歴から埋めない。
 *
 * 以前はここで直近サンプルから欠損を埋めていたが、 サンプルは 10 分毎に書かれ、 各行が
 * 前の行を継承するので鎖が切れず、 提供元が報告をやめた枠の値を無期限に複製していた
 * (実例: Codex は 5H 枠が廃止されて `secondary: null` を返すようになった後も、
 * 2026-07-19 に観測した 71% が 2 か月ぶんコピーされ、 存在しない時系列がグラフに出ていた)。
 *
 * 一時的な取得失敗の穴埋めは取得層が既に持っている — codex-rate-limits と
 * anthropic-oauth-usage は「直近の成功値を 30 分まで返す」を実装しており、 そちらは
 * 値を実際に観測した時刻を基準にするので鎖にならない。 ここで二重に持つ必要は無く、
 * 持つと壊れた側が勝つ。
 */
function observedOnly(sample: CostLimitSampleInput): CostLimitSampleInput | null {
  return hasLimitValue(sample.used_5h_pct, sample.used_weekly_pct) ? sample : null;
}
