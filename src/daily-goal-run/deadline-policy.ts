/**
 * 締切 (翌朝の業務日境界) の判断 (純関数)。
 *
 * @implements spec/feature/daily-goal-run.md — 6. 終わり方 (締切) / 8. 4:00 の締切 / CC-DG-INV-05
 *
 * 止まる条件のうち時刻を受けるのはここだけ。 0:00 (日付の変わり目) では止めない。
 */

import { deadlineOf } from "./business-day.js";
import type { DailyGoal } from "./domain.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:60540c97 */
import augurContract_dbbd329a from './goals-past-deadline.contract.js'; /* augur-inject:contract-predicate:b1b4d77b */

/** 締切に達した、 まだ止まっていない (登録済み・継続中の) ゴール。 */
export function goalsPastDeadline(goals: readonly DailyGoal[], now: number, boundary: string): DailyGoal[] {
  return goals.filter((goal) => (goal.status === "confirmed" || goal.status === "running") && now >= deadlineOf(goal.date, boundary));
}
// @ts-expect-error augur-inject
goalsPastDeadline = contract(goalsPastDeadline, { ...augurContract_dbbd329a, contractId: 'dg-C-8', mode: 'observe', sample: 1, where: 'src/daily-goal-run/deadline-policy.ts:13', rule: 'contract-wrap', id: 'dbbd329a' }); /* augur-inject:contract-wrap:dbbd329a */

/** 業務日の締切を過ぎたか。 */
export function isPastDeadline(businessDate: string, now: number, boundary: string): boolean {
  return now >= deadlineOf(businessDate, boundary);
}

/** 締切の前 windowMinutes 分以内か (カードに締切が近いことを出す)。 */
export function isNearDeadline(businessDate: string, at: number, boundary: string, windowMinutes = 30): boolean {
  const deadline = deadlineOf(businessDate, boundary);
  return at < deadline && deadline - at <= windowMinutes * 60_000;
}
