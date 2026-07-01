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

export function collectLimitSamples(report: CostReport, nowSec: number): CostLimitSampleInput[] {
  const samples: CostLimitSampleInput[] = [];
  if (hasLimitValue(report.codexRate.used5h, report.codexRate.usedWeekly)) {
    samples.push({
      ts: nowSec,
      provider: "codex-cli",
      plan: report.codexRate.plan,
      used_5h_pct: report.codexRate.used5h,
      used_weekly_pct: report.codexRate.usedWeekly,
      reset_5h_at: report.codexRate.reset5hAt,
      reset_weekly_at: report.codexRate.resetWeeklyAt,
    });
  }
  if (report.claudeUsage && hasLimitValue(report.claudeUsage.fiveHour?.utilization ?? null, report.claudeUsage.sevenDay?.utilization ?? null)) {
    samples.push({
      ts: nowSec,
      provider: "claude-code",
      plan: report.claudeUsage.plan,
      used_5h_pct: report.claudeUsage.fiveHour?.utilization ?? null,
      used_weekly_pct: report.claudeUsage.sevenDay?.utilization ?? null,
      reset_5h_at: report.claudeUsage.fiveHour?.resetsAtSec ?? null,
      reset_weekly_at: report.claudeUsage.sevenDay?.resetsAtSec ?? null,
    });
  }
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
