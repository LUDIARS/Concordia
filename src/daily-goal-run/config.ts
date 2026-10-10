/**
 * デイリーゴール自走の設定値を都度解決する (純関数 + 注入された getter)。
 *
 * @implements spec/feature/daily-goal-run.md — 設定 (確認の間隔 / 業務日の境界 / 通知時刻)
 *
 * 保存先は schema_meta (設定レジストリ `daily_goal.*`)。 env には依存しない。
 */

import { DEFAULT_CHECKPOINT_MINUTES } from "./checkpoint-policy.js";
import { DEFAULT_DAY_BOUNDARY, DEFAULT_REMINDER_TIME, formatClock, parseClock } from "./business-day.js";

export const DAILY_GOAL_SETTING_KEYS = {
  checkpointMinutes: "admin.daily_goal_checkpoint_minutes",
  dayBoundary: "admin.daily_goal_day_boundary",
  reminderTime: "admin.daily_goal_reminder_time",
} as const;

export interface DailyGoalConfig {
  checkpointMinutes: number;
  /** 業務日の境界 = 締切 (HH:MM)。 */
  dayBoundary: string;
  /** 目標が無い日の通知時刻 (HH:MM)。 */
  reminderTime: string;
}

/** 設定値を読む。 不正な値は既定 (60 分 / 04:00 / 09:00) に倒す。 */
export function resolveDailyGoalConfig(get: (key: string) => string | null): DailyGoalConfig {
  const minutes = Number(get(DAILY_GOAL_SETTING_KEYS.checkpointMinutes));
  return {
    checkpointMinutes: Number.isInteger(minutes) && minutes >= 5 && minutes <= 24 * 60 ? minutes : DEFAULT_CHECKPOINT_MINUTES,
    dayBoundary: formatClock(parseClock(get(DAILY_GOAL_SETTING_KEYS.dayBoundary), DEFAULT_DAY_BOUNDARY)),
    reminderTime: formatClock(parseClock(get(DAILY_GOAL_SETTING_KEYS.reminderTime), DEFAULT_REMINDER_TIME)),
  };
}
