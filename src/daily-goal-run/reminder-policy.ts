/**
 * 9:00 の「目標なし」通知を出すかの判断 (純関数)。
 *
 * @implements spec/feature/daily-goal-run.md — 7. 9:00 の通知 / CC-DG-INV-11
 *
 * 業務日の通知時刻 (既定 09:00) を過ぎ、 締切前で、 ゴール・下書き・目標なしが 1 件も無く、
 * まだ通知していない日だけ通知する。 通知は 1 業務日に 1 回。
 */

import type { ReminderState } from "./domain.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:169829d3 */
import augurContract_a41ad1cc from './decide-reminder.contract.js'; /* augur-inject:contract-predicate:7b57cc25 */

export interface ReminderInput {
  now: number;
  /** その業務日の通知時刻 (epoch ms)。 */
  reminderAt: number;
  /** その業務日の締切 (epoch ms)。 */
  deadlineAt: number;
  reminderState: ReminderState;
  hasGoal: boolean;
  hasDraft: boolean;
  noGoal: boolean;
}

export function decideReminder(input: ReminderInput): "notify" | "skip" {
  if (input.reminderState !== "none") return "skip";
  if (input.hasGoal || input.hasDraft || input.noGoal) return "skip";
  if (input.now < input.reminderAt || input.now >= input.deadlineAt) return "skip";
  return "notify";
}
// @ts-expect-error augur-inject
decideReminder = contract(decideReminder, { ...augurContract_a41ad1cc, contractId: 'dg-C-10', mode: 'observe', sample: 1, where: 'src/daily-goal-run/reminder-policy.ts:24', rule: 'contract-wrap', id: 'a41ad1cc' }); /* augur-inject:contract-wrap:a41ad1cc */
