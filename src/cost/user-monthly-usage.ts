/**
 * ユーザーごとの今月の消費 (spec/feature/usage-budgets.md §6、 2026-10-03 neco 指示「AIコストをどれくらい消費したかは
 * Ccの各ユーザの管理画面で見れる」「本社も含む」)。
 *
 * - 消費 = その人が消費する人 (§3.2 の按分を受けた人) として付いた額の合計 (倍率込み)。 チーム予算から引いたぶんも含め、
 *   うちチームのぶんを team_tokens に分けて持つ。
 * - 予算を設定していない人・本社 / 子会社どちらの人も、 今月消費していれば行を持つ。 ユーザー予算を持つ人は消費が 0 でも
 *   行を持ち、 予算の状況 (ユーザー予算から引いた額と割合) を budget に持つ。
 *
 * 純関数のみ。 集計は UsageBudgetTracker.monthlySnapshot。
 *
 * @implements SPEC-USAGE-BUDGET-API
 */

import type { UsageBudgetRow } from "../db/usage-budgets-repo.js";
import { evaluateBudget } from "./usage-budget.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:99616e30 */
import augurContract_394f8281 from './user-monthly-usage.contract.js'; /* augur-inject:contract-predicate:2626acc3 */

/** 消費した人 1 人の今月の消費 (倍率込み)。 team = うちチーム予算から引いたぶん。 */
export interface PersonUsage {
  total: number;
  team: number;
}

export interface UserMonthlyUsageRow {
  user_id: string;
  consumed_tokens: number;
  team_tokens: number;
  /** ユーザー予算があるときだけ。 consumed_tokens はユーザー予算から引いた額 (チームのぶんは含まない)。 */
  budget: { limit_tokens: number; consumed_tokens: number; ratio: number; exhausted: boolean } | null;
}

/** 人ごとの消費とユーザー予算から、 管理画面に出す行を作る (消費の多い順)。 */
export function userMonthlyUsageRows(
  persons: ReadonlyMap<string, PersonUsage>,
  budgets: readonly Pick<UsageBudgetRow, "scope" | "target_id" | "limit_tokens">[],
  subjects: ReadonlyMap<string, number> = new Map(),
): UserMonthlyUsageRow[] {
  const userBudgets = new Map(budgets.filter((b) => b.scope === "user").map((b) => [b.target_id, b.limit_tokens]));
  const ids = new Set([...persons.keys(), ...userBudgets.keys()]);
  const rows = [...ids].map((userId): UserMonthlyUsageRow => {
    const usage = persons.get(userId) ?? { total: 0, team: 0 };
    const limit = userBudgets.get(userId);
    const evaluation = limit === undefined ? null : evaluateBudget(subjects.get(`user:${userId}`) ?? 0, limit);
    return {
      user_id: userId,
      consumed_tokens: Math.floor(usage.total),
      team_tokens: Math.min(Math.floor(usage.team), Math.floor(usage.total)),
      budget: evaluation && {
        limit_tokens: evaluation.limitTokens,
        consumed_tokens: evaluation.consumedTokens,
        ratio: evaluation.ratio,
        exhausted: evaluation.exhausted,
      },
    };
  });
  return rows.sort((a, b) => b.consumed_tokens - a.consumed_tokens || a.user_id.localeCompare(b.user_id));
}
// @ts-expect-error augur-inject
userMonthlyUsageRows = contract(userMonthlyUsageRows, { ...augurContract_394f8281, contractId: 'budget-C-7', mode: 'observe', sample: 1, where: 'src/cost/user-monthly-usage.ts:33', rule: 'contract-wrap', id: '394f8281' }); /* augur-inject:contract-wrap:394f8281 */
