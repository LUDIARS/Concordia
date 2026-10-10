/**
 * 止まる条件の判断 (純関数)。
 *
 * @implements spec/feature/daily-goal-run.md — 6. 終わり方 / CC-DG-INV-03 / CC-DG-INV-05 / CC-DG-INV-06
 *
 * 止まる条件は 4 つだけ: ゴール到達・十分にこなした・人間の停止・締切 (翌朝の業務日境界)。
 * 締切の時刻判断は deadline-policy.ts だけが持つ。 ここの判断関数は時刻を入力に取らず、
 * 日付の変わり目 (0:00)・進捗の停滞では止めない。
 */

import type { RemainingItem } from "./domain.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:d7bfa5b8 */
import augurContract_56c7f597 from './goal-reached.contract.js'; /* augur-inject:contract-predicate:9e684a9c */
import augurContract_e832796c from './exhausted.contract.js'; /* augur-inject:contract-predicate:f7de827f */

/** 止まる条件の一覧 (CC-DG-INV-05)。 喪失は止まる条件ではなく状態として扱う。 */
export const STOP_CONDITIONS = ["goal_reached", "exhausted", "human_stop", "deadline"] as const;
export type StopCondition = (typeof STOP_CONDITIONS)[number];

export type GoalReachedResult =
  | { reached: true }
  | { reached: false; missing: string[] };

/**
 * 受入条件の全項目に、 Cc が集めた証跡が 1 件以上対応していれば到達。
 * evidenceByItem には「セッションが挙げた証跡のうち Cc が実在を確認できたもの」だけを渡す。
 * セッションの自己申告だけ (証跡なし) の項目は到達にしない。
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

export type ExhaustedResult =
  | { accepted: true }
  | { accepted: false; reason: "doable_remaining"; doable: string[] }
  | { accepted: false; reason: "invalid_items"; invalid: string[] };

/**
 * 「十分にこなした」の判定。 残りの一つずつが 達成不能 (理由付き) か 人間判断待ち のときだけ認める。
 * doable が 1 件でもあれば拒否して続行させる。 人間判断待ちが実在するか (未回答の質問・
 * active な人間待ち) は use case が port で照合し、 結果を humanJudgmentExists で渡す。
 */
export function evaluateExhausted(
  remaining: readonly RemainingItem[],
  humanJudgmentExists: (item: Extract<RemainingItem, { class: "human_judgment" }>) => boolean,
): ExhaustedResult {
  if (remaining.length === 0) return { accepted: false, reason: "invalid_items", invalid: ["(残りの一覧が空です)"] };
  const doable = remaining.filter((item) => item.class === "doable").map((item) => item.item);
  if (doable.length > 0) return { accepted: false, reason: "doable_remaining", doable };
  const invalid: string[] = [];
  for (const item of remaining) {
    if (!item.item.trim()) invalid.push("(項目名が空です)");
    else if (item.class === "unachievable" && !item.reason.trim()) invalid.push(`${item.item}: 達成不能の理由がありません`);
    else if (item.class === "human_judgment") {
      if (item.questionId === undefined && item.humanWait !== true) invalid.push(`${item.item}: 対応する質問か人間依頼がありません`);
      else if (!humanJudgmentExists(item)) invalid.push(`${item.item}: 未回答の質問・人間依頼を確認できません`);
    }
  }
  return invalid.length > 0 ? { accepted: false, reason: "invalid_items", invalid } : { accepted: true };
}
// @ts-expect-error augur-inject
evaluateExhausted = contract(evaluateExhausted, { ...augurContract_e832796c, contractId: 'dg-C-6', mode: 'observe', sample: 1, where: 'src/daily-goal-run/stop-policy.ts:40', rule: 'contract-wrap', id: 'e832796c' }); /* augur-inject:contract-wrap:e832796c */

/** 人間の停止は本人の操作のみ。 登録した本人か、 session_control (管理職以上) を持つ人。 */
export function canHumanStop(input: { isHuman: boolean; isConfirmer: boolean; hasSessionControl: boolean }): boolean {
  return input.isHuman && (input.isConfirmer || input.hasSessionControl);
}
