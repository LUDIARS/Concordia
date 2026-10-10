/**
 * 専用セッションを起動してよいかの判断 (純関数)。
 *
 * @implements spec/feature/daily-goal-run.md — 3. 専用セッションを起動する (登録したらその場で起動)
 *
 * 起動時刻の制限は持たない。 登録済み・起動未着手のゴールは、 失敗後のバックオフ中でなければ即起動する。
 */

import type { DailyGoal } from "./domain.js";

export function isDue(goal: DailyGoal, now: number): boolean {
  if (goal.status !== "confirmed" || goal.launchState !== "none") return false;
  return goal.nextLaunchAt === undefined || goal.nextLaunchAt <= now;
}
