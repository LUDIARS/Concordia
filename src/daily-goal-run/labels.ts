/**
 * ゴールの許可範囲・Actio task を表示用の 1 行にする (純関数)。
 *
 * @implements spec/feature/daily-goal-run.md — 2. 読み取り結果の返信 / 4. カード
 */

import { PERMISSION_KEYS, PERMISSION_LABELS, type GoalPermissions } from "./domain.js";

export function describePermissions(permissions: GoalPermissions): string {
  return PERMISSION_KEYS.map((key) => `${PERMISSION_LABELS[key]}=${permissions[key] ? "可" : "不可"}`).join(" / ");
}

export function describeActioTasks(ids: readonly string[]): string {
  return ids.length ? ids.map((id) => `actio:${id}`).join(", ") : "なし";
}
