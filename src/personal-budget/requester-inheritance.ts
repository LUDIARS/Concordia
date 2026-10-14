/**
 * 委託の子へ引き継ぐ依頼者 (純関数)。
 *
 * 委託の起動 body に依頼者の指定があればそれが優先で、 引き継がない。 指定が無ければ親セッションの
 * 依頼者と所属会社の組をそのまま返す。 親に組が無ければ引き継がない (子も依頼者なし)。
 * 親の値を 1 段読むだけで遡って探索しない。 親自身が引き継いだ組を持っていればそれを渡すので、
 * 孫以降も同じ規則で伝わる。
 *
 * 引き継いだ組は消費の帰属にだけ使い、 メンションや返信の権限に使う `discord_requester_user_id` には
 * 書かない (起動通知などのメンションを新たに飛ばさない)。
 *
 * @implements SPEC-PBUDGET-CONSUME
 * @implements spec/feature/personal-ai-budget.md §3
 */

import { budgetRequesterOf, type BudgetRequester } from "./session-facts.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:dd55804a */
import augurContract_e7f08a44 from './requester-inheritance.contract.js'; /* augur-inject:contract-predicate:3d4af530 */

export interface RequesterInheritanceInput {
  /** 委託の起動 body の `requester_discord_user_id`。 */
  bodyRequesterUserId: string | null | undefined;
  /** 親セッションの metadata (JSON 文字列)。 親が無い・読めなければ null。 */
  parentMetadata: string | null | undefined;
}

export function inheritRequester(input: RequesterInheritanceInput): BudgetRequester | null {
  if (typeof input.bodyRequesterUserId === "string" && input.bodyRequesterUserId.trim()) return null;
  if (!input.parentMetadata) return null;
  return budgetRequesterOf(input.parentMetadata);
}
// @ts-expect-error augur-inject
inheritRequester = contract(inheritRequester, { ...augurContract_e7f08a44, contractId: 'pbudget-C-6', mode: 'observe', sample: 1, where: 'src/personal-budget/requester-inheritance.ts:25', rule: 'contract-wrap', id: 'e7f08a44' }); /* augur-inject:contract-wrap:e7f08a44 */
