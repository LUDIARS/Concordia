/**
 * 本社の調整 (「〇〇に報酬」) の可否 (純関数)。
 *
 * 調整は本社の権限者だけが行い、 理由の無い調整は受けない。 減額は残高 0 まで (CC-PBUDGET-INV-06 / 02)。
 *
 * @implements SPEC-PBUDGET-ADJUST
 * @implements spec/feature/personal-ai-budget.md §6
 */

import { MAX_TOKENS_PER_ENTRY } from "./types.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:9ffae5b2 */
import augurContract_17a550c6 from './adjustment-policy.contract.js'; /* augur-inject:contract-predicate:75899e88 */

export type AdjustmentError =
  | "not_authorized"
  | "reason_required"
  | "invalid_tokens"
  | "nothing_to_reduce";

export interface AdjustmentInput {
  /** 操作者が社員名簿の権限者 (既定は管理職以上) か。 */
  actorAuthorized: boolean;
  /** 増減させるトークン数。 負なら減額。 */
  tokens: number;
  reason: string;
  /** 対象の今の報酬分の残り。 */
  rewardBalance: number;
}

export type AdjustmentDecision =
  | { ok: true; applied: number; reason: string }
  | { ok: false; error: AdjustmentError };

export const MAX_REASON_LENGTH = 500;

export function decideAdjustment(input: AdjustmentInput): AdjustmentDecision {
  if (!input.actorAuthorized) return { ok: false, error: "not_authorized" };
  const reason = input.reason.trim();
  if (!reason) return { ok: false, error: "reason_required" };
  if (!Number.isInteger(input.tokens) || input.tokens === 0 || Math.abs(input.tokens) > MAX_TOKENS_PER_ENTRY) {
    return { ok: false, error: "invalid_tokens" };
  }
  const boundedReason = reason.slice(0, MAX_REASON_LENGTH);
  if (input.tokens > 0) return { ok: true, applied: input.tokens, reason: boundedReason };
  const balance = Number.isFinite(input.rewardBalance) && input.rewardBalance > 0 ? Math.floor(input.rewardBalance) : 0;
  const reduce = Math.min(-input.tokens, balance);
  if (reduce === 0) return { ok: false, error: "nothing_to_reduce" };
  return { ok: true, applied: -reduce, reason: boundedReason };
}
// @ts-expect-error augur-inject
decideAdjustment = contract(decideAdjustment, { ...augurContract_17a550c6, contractId: 'pbudget-C-5', mode: 'observe', sample: 1, where: 'src/personal-budget/adjustment-policy.ts:34', rule: 'contract-wrap', id: '17a550c6' }); /* augur-inject:contract-wrap:17a550c6 */

export type AdjustmentTargetError = "head_office_member" | "ambiguous_subsidiary" | "not_in_subsidiary";

export type AdjustmentTarget =
  | { ok: true; subsidiaryId: string }
  | { ok: false; error: AdjustmentTargetError; candidates: string[] };

/**
 * 調整の対象の会社を決める。 対象は子会社に所属する個人だけ。
 * 複数の子会社に居る人は `subsidiary` の指定が要る (未指定で決まらなければ付けずに候補を返す)。
 */
export function resolveAdjustmentTarget(input: {
  /** その人が所属する子会社の id。 */
  memberships: readonly string[];
  requestedSubsidiaryId: string | null;
}): AdjustmentTarget {
  const memberships = [...new Set(input.memberships)];
  if (input.requestedSubsidiaryId) {
    return memberships.includes(input.requestedSubsidiaryId)
      ? { ok: true, subsidiaryId: input.requestedSubsidiaryId }
      : { ok: false, error: "not_in_subsidiary", candidates: memberships };
  }
  if (memberships.length === 0) return { ok: false, error: "head_office_member", candidates: [] };
  if (memberships.length > 1) return { ok: false, error: "ambiguous_subsidiary", candidates: memberships };
  return { ok: true, subsidiaryId: memberships[0]! };
}

export const ADJUSTMENT_ERROR_LABEL: Record<AdjustmentError | AdjustmentTargetError, string> = {
  not_authorized: "報酬の調整は本社の権限者 (管理職以上) だけが行えます。",
  reason_required: "理由を入力してください。理由の無い調整は受け付けません。",
  invalid_tokens: "トークン数は 0 以外の整数で、10 億以下にしてください。",
  nothing_to_reduce: "報酬分の残りが 0 のため、減額できません。",
  head_office_member: "対象は子会社に所属する個人だけです。本社メンバーへの調整は受け付けません。",
  ambiguous_subsidiary: "この人は複数の子会社に所属しています。subsidiary を指定してください。",
  not_in_subsidiary: "この人は指定した子会社に所属していません。",
};
