/**
 * 9:00 の通知の use case: 目標の無い日に 1 回だけ、 デイリーゴールチャンネルへ通知を置く。
 *
 * @implements spec/feature/daily-goal-run.md — 7. 9:00 の通知 / CC-DG-INV-11 / CC-INV-03
 *
 * 判断は reminder-policy。 通知の intent を daily_goal_days に先に保存し、 投稿はカード
 * (結果不明は照合して再送しない) として配達側へ渡す。
 */

import { businessDateOf, deadlineOf, localTimeOn } from "./business-day.js";
import { decideReminder } from "./reminder-policy.js";
import type { DailyGoalServiceDeps } from "./ports.js";

export function reminderCardId(date: string): string { return `reminder-${date}`; }

export class DailyGoalReminder {
  constructor(private readonly deps: DailyGoalServiceDeps, private readonly touchReminderCard: (date: string) => void) {}

  notifyIfDue(now: number): boolean {
    const { dayBoundary, reminderTime } = this.deps.config();
    const date = businessDateOf(now, dayBoundary);
    const day = this.deps.days.get(date);
    const decision = decideReminder({
      now,
      reminderAt: localTimeOn(date, reminderTime),
      deadlineAt: deadlineOf(date, dayBoundary),
      reminderState: day?.reminderState ?? "none",
      hasGoal: this.deps.repo.onDate(date).length > 0,
      hasDraft: this.deps.drafts.onDate(date).length > 0,
      noGoal: day?.noGoalAt !== undefined,
    });
    if (decision !== "notify" || !this.deps.days.claimReminder(date, now)) return false;
    this.touchReminderCard(date);
    return true;
  }
}
