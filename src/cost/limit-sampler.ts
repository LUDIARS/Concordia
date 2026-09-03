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

/**
 * 直近値を持ち越してよい上限。 取得は 10 分毎なので、 数回ぶんの一時的な失敗を
 * 埋めるには足りる (codex-rate-limits の STALE_FALLBACK_MS と同じ考え方)。
 */
const CARRY_FORWARD_MAX_AGE_SEC = 30 * 60;

/**
 * 一時的な取得失敗で時系列に穴を空けないよう、 直近値を持ち越す。
 *
 * ただし持ち越しは「まだ取れるはずの値が今回だけ取れなかった」場合に限る。 無期限に
 * 持ち越すと、 廃止された枠の値を複製し続けてしまう。 古すぎる値や現在より未来の値は
 * 持ち越さず null のまま記録して、 「取れていない」ことを時系列に残す。
 *
 * @implements spec/feature/cost-observability.md (`SPEC-COST-LIMIT-CARRY-FORWARD`)
 */
function carryForwardMissing(
  current: CostLimitSampleInput,
  previous: CostLimitSampleRow | undefined,
): CostLimitSampleInput | null {
  const previousAgeSec = previous ? current.ts - previous.ts : null;
  const carryable = previous && previousAgeSec !== null
    && previousAgeSec >= 0
    && previousAgeSec <= CARRY_FORWARD_MAX_AGE_SEC
    ? previous
    : undefined;
  if (!previous && !hasLimitValue(current.used_5h_pct, current.used_weekly_pct)) return null;
  return {
    ...current,
    plan: current.plan ?? carryable?.plan ?? null,
    used_5h_pct: current.used_5h_pct ?? carryable?.used_5h_pct ?? null,
    used_weekly_pct: current.used_weekly_pct ?? carryable?.used_weekly_pct ?? null,
    reset_5h_at: current.reset_5h_at ?? carryable?.reset_5h_at ?? null,
    reset_weekly_at: current.reset_weekly_at ?? carryable?.reset_weekly_at ?? null,
  };
}
