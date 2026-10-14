/**
 * 止まる条件の判断 (純関数)。
 *
 * @implements spec/feature/daily-goal-run.md — 6. 終わり方 / CC-DG-INV-03 / CC-DG-INV-05
 *
 * 止まる条件は 3 つだけ: ゴール到達・人間の停止・締切 (翌朝の業務日境界)。
 * 締切の時刻判断は deadline-policy.ts だけが持つ。 ここの判断関数は時刻を入力に取らず、
 * 日付の変わり目 (0:00)・不調では止めない。
 */

import { contract } from './ontime-runtime.js'; /* augur-inject:import:d7bfa5b8 */
import augurContract_56c7f597 from './goal-reached.contract.js'; /* augur-inject:contract-predicate:9e684a9c */

/** 止まる条件の一覧 (CC-DG-INV-05)。 */
export const STOP_CONDITIONS = ["goal_reached", "human_stop", "deadline"] as const;
export type StopCondition = (typeof STOP_CONDITIONS)[number];

export type GoalReachedResult =
  | { reached: true }
  | { reached: false; missing: string[] };

/**
 * 受入条件の全項目に、 Cc が集めた証跡が 1 件以上対応していれば到達。
 * evidenceByItem には「判定が根拠に挙げた証跡のうち Cc が実在を確認できたもの」だけを渡す。
 * 証跡の無い項目は到達にしない。
 */
export function evaluateGoalReached(
  acceptance: readonly string[],
  evidenceByItem: ReadonlyMap<string, readonly string[]>,
): GoalReachedResult {
  if (acceptance.length === 0) return { reached: false, missing: [] };
  const missing = acceptance.filter((item) => (evidenceByItem.get(item)?.length ?? 0) === 0);
  return missing.length === 0 ? { reached: true } : { reached: false, missing };
}
// @ts-expect-error augur-inject
evaluateGoalReached = contract(evaluateGoalReached, { ...augurContract_56c7f597, contractId: 'dg-C-5', mode: 'observe', sample: 1, where: 'src/daily-goal-run/stop-policy.ts:21', rule: 'contract-wrap', id: '56c7f597' }); /* augur-inject:contract-wrap:56c7f597 */

/** 人間の停止は本人の操作のみ。 登録した本人か、 session_control (管理職以上) を持つ人。 */
export function canHumanStop(input: { isHuman: boolean; isConfirmer: boolean; hasSessionControl: boolean }): boolean {
  return input.isHuman && (input.isConfirmer || input.hasSessionControl);
}
