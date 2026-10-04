import { contract } from './ontime-runtime.js'; /* augur-inject:import:d1bc966b */
import augurContract_94d6445c from './allocation.contract.js'; /* augur-inject:contract-predicate:e6d73853 */
import augurContract_9f5d5be7 from './consumption-delta.contract.js'; /* augur-inject:contract-predicate:59eed8db */
/**
 * 個人の消費の割り当て (純関数)。 月間分から先に引き、 足りないぶんを報酬分から引く。
 *
 * @implements SPEC-PBUDGET-CONSUME
 * @implements spec/feature/personal-ai-budget.md §3
 */

export interface AllocationInput {
  /** 今回数える消費 (累積トークンの正の差分)。 */
  delta: number;
  /** 月間分の上限。 0 = 上限なし。 */
  monthlyLimit: number;
  /** 今月すでに月間分として数えた消費。 */
  monthlyUsed: number;
  /** 報酬分の残り。 */
  rewardBalance: number;
  /** 子会社の日次 budget が超過中か。 超過中は月間分では通していないので報酬分から引く。 */
  subsidiaryOver: boolean;
}

export interface Allocation {
  /** 月間分の累積へ足すトークン。 上限を超えて走り切った実行中セッションのぶんもここへ入る。 */
  monthly: number;
  /** 報酬分から引くトークン (台帳の debit)。 残高を超えない。 */
  reward: number;
}

function wholeTokens(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * 差分を月間分と報酬分へ振り分ける (CC-PBUDGET-INV-01 / 02)。
 *
 * 実行中のセッションは打ち切らないので、 両方が尽きた後の消費も起こりうる。 そのぶんは
 * 月間分の累積へ記録し (残りは 0 のまま)、 報酬分は負にしない。
 */
export function allocateConsumption(input: AllocationInput): Allocation {
  const delta = wholeTokens(input.delta);
  const balance = wholeTokens(input.rewardBalance);
  if (delta === 0) return { monthly: 0, reward: 0 };
  if (input.subsidiaryOver) {
    const reward = Math.min(delta, balance);
    return { monthly: delta - reward, reward };
  }
  const limit = wholeTokens(input.monthlyLimit);
  // 上限なしの個人は報酬分を引かない (既定。 現状の動きを変えない)。
  if (limit === 0) return { monthly: delta, reward: 0 };
  const remaining = Math.max(0, limit - wholeTokens(input.monthlyUsed));
  const fromMonthly = Math.min(delta, remaining);
  const reward = Math.min(delta - fromMonthly, balance);
  return { monthly: delta - reward, reward };
}
// @ts-expect-error augur-inject
allocateConsumption = contract(allocateConsumption, { ...augurContract_94d6445c, contractId: 'pbudget-C-1', mode: 'observe', sample: 1, where: 'src/personal-budget/allocation.ts:38', rule: 'contract-wrap', id: '94d6445c' }); /* augur-inject:contract-wrap:94d6445c */

/** 累積トークンの差分。 負の差分 (ログの巻き戻り等) は 0 にする (CC-PBUDGET-INV-05)。 */
export function consumptionDelta(lastTotal: number, total: number): number {
  const delta = wholeTokens(total) - wholeTokens(lastTotal);
  return delta > 0 ? delta : 0;
}
// @ts-expect-error augur-inject
consumptionDelta = contract(consumptionDelta, { ...augurContract_9f5d5be7, contractId: 'pbudget-C-2', mode: 'observe', sample: 1, where: 'src/personal-budget/allocation.ts:56', rule: 'contract-wrap', id: '9f5d5be7' }); /* augur-inject:contract-wrap:9f5d5be7 */

/**
 * 初めて見たセッションの baseline。
 *
 * 個人の行より後に始まったセッションは 0 から数える。 行より前から動いていたセッションは、
 * 導入前の累積を今月の消費として一括計上しないよう、 その時点の累積を baseline にする。
 */
export function initialBaseline(input: { sessionStartedAtMs: number; personCreatedAtMs: number; total: number }): number {
  return input.sessionStartedAtMs >= input.personCreatedAtMs ? 0 : wholeTokens(input.total);
}
