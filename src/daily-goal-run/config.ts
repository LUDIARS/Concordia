/**
 * デイリーゴール自走の設定値を都度解決する (純関数 + 注入された getter)。
 *
 * @implements spec/feature/daily-goal-run.md — 3. 起動時刻 (設定可) / 1. 候補カード
 *
 * 保存先は schema_meta (設定レジストリ `daily_goal.*`)。 env には依存しない。
 */

import { DEFAULT_CHECKPOINT_MINUTES } from "./checkpoint-policy.js";
import { DEFAULT_LAUNCH_TIME, parseLaunchTime } from "./launch-policy.js";

export const DAILY_GOAL_SETTING_KEYS = {
  launchTime: "admin.daily_goal_launch_time",
  checkpointMinutes: "admin.daily_goal_checkpoint_minutes",
  candidateProjects: "admin.daily_goal_candidate_projects",
} as const;

export interface DailyGoalConfig {
  launchTime: string;
  checkpointMinutes: number;
  candidateProjects: string[];
}

function parseList(raw: string | null): string[] {
  if (!raw?.trim()) return [];
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === "string" && !!v.trim()).map((v) => v.trim());
    } catch { /* fall through to `;` separated */ }
  }
  return trimmed.split(/[;,\n]/).map((v) => v.trim()).filter(Boolean);
}

/** 設定値を読む。 不正な値は既定 (07:30 / 60 分 / 候補なし) に倒す。 */
export function resolveDailyGoalConfig(get: (key: string) => string | null): DailyGoalConfig {
  const rawTime = get(DAILY_GOAL_SETTING_KEYS.launchTime);
  const { hour, minute } = parseLaunchTime(rawTime ?? DEFAULT_LAUNCH_TIME);
  const minutes = Number(get(DAILY_GOAL_SETTING_KEYS.checkpointMinutes));
  return {
    launchTime: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    checkpointMinutes: Number.isInteger(minutes) && minutes >= 5 && minutes <= 24 * 60 ? minutes : DEFAULT_CHECKPOINT_MINUTES,
    candidateProjects: parseList(get(DAILY_GOAL_SETTING_KEYS.candidateProjects)),
  };
}
