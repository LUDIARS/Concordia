import { contract } from './ontime-runtime.js'; /* augur-inject:import:d6c1677d */
import augurContract_56c60ea1 from './dispatch-policy.contract.js'; /* augur-inject:contract-predicate:73cd5812 */
/**
 * 払い出しの判定 (純関数)。 spec §3 の表をそのまま持つ。
 *
 * 個人の予算が効いていない人 (個人を特定できない、 または月間分の上限が 0 かつ報酬分が 0) は、
 * 導入前と同じく子会社の日次 budget だけで決める。 全体の日次 budget は、 個人の予算が効いている人に
 * ついて個人の予算より先に見る (CC-PBUDGET-INV-03)。
 *
 * @implements SPEC-PBUDGET-CONSUME
 * @implements spec/feature/personal-ai-budget.md §3
 */

export type DispatchStopReason = "global_over" | "subsidiary_over" | "monthly_exhausted";

/** 通したときに消費を引く先。 `none` は個人の予算が効いていない (従来どおり)。 */
export type DispatchSource = "none" | "monthly" | "reward";

export interface DispatchPersonState {
  /** 月間分の上限。 0 = 上限なし。 */
  monthlyLimit: number;
  monthlyUsed: number;
  rewardBalance: number;
}

export interface DispatchInput {
  /** 全体の日次 budget が超過中か。 */
  globalOver: boolean;
  /** 子会社の日次 budget が超過中か。 */
  subsidiaryOver: boolean;
  /** 個人の状態。 個人を特定できない・対象外なら null (CC-PBUDGET-INV-07)。 */
  person: DispatchPersonState | null;
}

export type DispatchDecision =
  | { allow: true; source: DispatchSource }
  | { allow: false; reason: DispatchStopReason; rewardBalance: number; inEffect: boolean };

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** 個人の予算が効いているか。 効いていなければ導入前の動きのまま。 */
export function isPersonalBudgetInEffect(person: DispatchPersonState | null): boolean {
  if (!person) return false;
  return nonNegative(person.monthlyLimit) > 0 || nonNegative(person.rewardBalance) > 0;
}

export function decideDispatch(input: DispatchInput): DispatchDecision {
  const person = input.person;
  if (!person || !isPersonalBudgetInEffect(person)) {
    return input.subsidiaryOver
      ? { allow: false, reason: "subsidiary_over", rewardBalance: 0, inEffect: false }
      : { allow: true, source: "none" };
  }
  const rewardBalance = nonNegative(person.rewardBalance);
  if (input.globalOver) return { allow: false, reason: "global_over", rewardBalance, inEffect: true };
  if (input.subsidiaryOver) {
    // 月間分が残っていても月間分では通さない。 報酬分が正の個人だけ通す。
    return rewardBalance > 0
      ? { allow: true, source: "reward" }
      : { allow: false, reason: "subsidiary_over", rewardBalance: 0, inEffect: true };
  }
  const limit = nonNegative(person.monthlyLimit);
  if (limit === 0 || nonNegative(person.monthlyUsed) < limit) return { allow: true, source: "monthly" };
  return rewardBalance > 0
    ? { allow: true, source: "reward" }
    : { allow: false, reason: "monthly_exhausted", rewardBalance: 0, inEffect: true };
}
// @ts-expect-error augur-inject
decideDispatch = contract(decideDispatch, { ...augurContract_56c60ea1, contractId: 'pbudget-C-3', mode: 'observe', sample: 1, where: 'src/personal-budget/dispatch-policy.ts:47', rule: 'contract-wrap', id: '56c60ea1' }); /* augur-inject:contract-wrap:56c60ea1 */
