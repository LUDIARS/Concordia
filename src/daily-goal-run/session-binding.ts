/**
 * 専用セッションの metadata へデイリーゴールを記す (純関数)。
 *
 * @implements spec/feature/daily-goal-run.md — 4. Goal & Go で自走 / CC-WM-INV-01 / CC-WM-INV-02
 *
 * Goal & Go の明示ゴール (`goal`) と方式 (`work_mode`) を書く。 ゴールの正本は Cc の
 * daily_goals に残し、 metadata には参照 (goal id) と表示用の文だけを置く。
 */

import { mergeGoalIntoMetadata } from "../control/goal.js";
import { closeWorkMode, withWorkMode } from "../work-modes/work-mode.js";
import type { DailyGoal } from "./domain.js";

export type BindResult = { ok: true; metadata: string } | { ok: false; reason: string; metadata: string };

export function bindGoalToMetadata(metadata: string | null, goal: DailyGoal, now: number): BindResult {
  const mode = withWorkMode(metadata, { mode: "daily-goal-run", ref: goal.id, since: now });
  if (!mode.ok) {
    return { ok: false, reason: `別の方式 (${mode.active.mode}) が active なため方式を記録しませんでした`, metadata: metadata ?? "{}" };
  }
  return { ok: true, metadata: mergeGoalIntoMetadata(mode.metadata, { mode: "scoped", text: `デイリーゴール ${goal.id}: ${goal.goalText}` }) };
}

/** 止まる条件に当たったら方式を閉じる (次の方式へ移れるようにする)。 */
export function releaseGoalFromMetadata(metadata: string | null, goal: DailyGoal): string {
  return closeWorkMode(metadata, "daily-goal-run", goal.id);
}
