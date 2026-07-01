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
  previous: CostLimitSampleRow[] = [],
): CostLimitSampleInput[] {
  const samples: CostLimitSampleInput[] = [];
  const previousByProvider = new Map(previous.map((p) => [p.provider, p]));
  const codexSample = carryForwardMissing({
      ts: nowSec,
      provider: "codex-cli",
      plan: report.codexRate.plan,
      used_5h_pct: report.codexRate.used5h,
      used_weekly_pct: report.codexRate.usedWeekly,
      reset_5h_at: report.codexRate.reset5hAt,
      reset_weekly_at: report.codexRate.resetWeeklyAt,
    },
    previousByProvider.get("codex-cli"),
  );
  if (codexSample) samples.push(codexSample);

  const claudeSample = carryForwardMissing(
    {
      ts: nowSec,
      provider: "claude-code",
      plan: report.claudeUsage?.plan ?? null,
      used_5h_pct: report.claudeUsage?.fiveHour?.utilization ?? null,
      used_weekly_pct: report.claudeUsage?.sevenDay?.utilization ?? null,
      reset_5h_at: report.claudeUsage?.fiveHour?.resetsAtSec ?? null,
      reset_weekly_at: report.claudeUsage?.sevenDay?.resetsAtSec ?? null,
    },
    previousByProvider.get("claude-code"),
  );
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

function carryForwardMissing(
  current: CostLimitSampleInput,
  previous: CostLimitSampleRow | undefined,
): CostLimitSampleInput | null {
  if (!previous && !hasLimitValue(current.used_5h_pct, current.used_weekly_pct)) return null;
  return {
    ...current,
    plan: current.plan ?? previous?.plan ?? null,
    used_5h_pct: current.used_5h_pct ?? previous?.used_5h_pct ?? null,
    used_weekly_pct: current.used_weekly_pct ?? previous?.used_weekly_pct ?? null,
    reset_5h_at: current.reset_5h_at ?? previous?.reset_5h_at ?? null,
    reset_weekly_at: current.reset_weekly_at ?? previous?.reset_weekly_at ?? null,
  };
}
