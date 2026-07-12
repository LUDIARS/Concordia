/**
 * Daily report scheduler.
 *
 * - 起動時 + 30 分ごとに 「今日」 + 「昨日」 の日報を確認
 * - 4 時間以上 stale なら再生成
 * - 「昨日」 は最後の翌 0:00 過ぎに 1 度だけ最終生成 (それ以降は touch しない)
 */

import type { SessionsRepo } from "../db/sessions-repo.js";
import type { DayReportsRepo } from "../db/day-reports-repo.js";
import { generateDayReport } from "./generator.js";
import { dayRange } from "./aggregator.js";
import { createChildLogger } from "../shared/logger.js";
import { startSupervisedInterval } from "../shared/loop-bulkhead.js";

const log = createChildLogger("daily-scheduler");
const TICK_MS = 30 * 60 * 1000;
const FRESHNESS_SEC = 4 * 3600;

export interface SchedulerDeps {
  sessions: SessionsRepo;
  dayReports: DayReportsRepo;
}

export interface SchedulerHandle {
  stop: () => void;
  runOnce: (date_iso?: string) => Promise<void>;
}

export function startDailyScheduler(deps: SchedulerDeps): SchedulerHandle {
  let stopped = false;

  const todayIso = (): string => dayRange(new Date()).iso;
  const yesterdayIso = (): string => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return dayRange(d).iso;
  };

  async function ensureFresh(date_iso: string): Promise<void> {
    if (stopped) return;
    const existing = deps.dayReports.find(date_iso);
    const ageSec = existing
      ? Math.floor(Date.now() / 1000) - existing.generated_at
      : Infinity;
    if (ageSec < FRESHNESS_SEC) return; // 十分新しい
    try {
      const report = await generateDayReport(date_iso, deps.sessions);
      deps.dayReports.upsert(report);
      log.info(
        { date: date_iso, sessions: report.session_count, regenerated: !!existing },
        "day report generated",
      );
    } catch (err) {
      log.warn({ err: (err as Error).message, date: date_iso }, "day report generation failed");
    }
  }

  async function runOnce(date_iso?: string): Promise<void> {
    const target = date_iso ?? todayIso();
    await ensureFresh(target);
  }

  async function tick(): Promise<void> {
    await ensureFresh(todayIso());
    await ensureFresh(yesterdayIso());
  }

  // 起動 5 秒後 + 30 分ごと
  const supervised = startSupervisedInterval("daily-scheduler", tick, {
    intervalMs: TICK_MS,
    initialDelayMs: 5_000,
    log: { warn: (message) => log.warn(message) },
  });

  log.info({ tickMs: TICK_MS }, "daily report scheduler started");
  return {
    stop: () => {
      stopped = true;
      supervised.stop();
    },
    runOnce,
  };
}
