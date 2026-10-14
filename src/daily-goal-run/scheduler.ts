/**
 * デイリーゴールの scheduler。 1 分ごとに tick し、 締切・確認 (ワンショット判定)・9:00 の通知を進める。
 *
 * @implements spec/feature/daily-goal-run.md — 4. 1 時間ごとのワンショット確認 / 7. 9:00 の通知 / 8. 4:00 の締切
 *
 * 時刻の判断は service の use case (deadline-policy / reminder-policy) が持つ。 0:00 では止めない。 tick の失敗は
 * loop-bulkhead が隔離し、 連続失敗で停止を通知する。 生成側が stop を所有する。
 */

import { startSupervisedInterval } from "../shared/loop-bulkhead.js";
import type { DailyGoalRunService } from "./service.js";

export const DAILY_GOAL_TICK_MS = 60_000;

export interface DailyGoalSchedulerOptions {
  service: Pick<DailyGoalRunService, "tick">;
  now?: () => number;
  intervalMs?: number;
  log?: { info(message: string): void; warn(message: string): void };
}

export interface DailyGoalSchedulerHandle { stop(): void; tick(): Promise<void> }

export function startDailyGoalScheduler(opts: DailyGoalSchedulerOptions): DailyGoalSchedulerHandle {
  const now = opts.now ?? Date.now;
  let running = false;
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try { await opts.service.tick(now()); }
    finally { running = false; }
  };
  const loop = startSupervisedInterval("daily-goal-run", tick, {
    intervalMs: opts.intervalMs ?? DAILY_GOAL_TICK_MS,
    initialDelayMs: 5_000,
    log: opts.log,
  });
  opts.log?.info("daily-goal-run scheduler started");
  return {
    tick,
    stop() {
      if (stopped) return;
      stopped = true;
      loop.stop();
    },
  };
}
