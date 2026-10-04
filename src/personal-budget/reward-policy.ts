/**
 * 報奨の可否と加算量 (純関数)。 種類と根拠ごとに 1 回だけ付ける。
 *
 * @implements SPEC-PBUDGET-REWARD
 * @implements spec/feature/personal-ai-budget.md §4 / §5
 */

import type { PersonResolution, PersonSkipReason } from "./person-resolution.js";
import { REWARD_SETTINGS, type RewardTier } from "./reward-settings.js";
import { MAX_TOKENS_PER_ENTRY, type BountySeverity, type PersonIdentity, type RewardKind } from "./types.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:eb9e8ec8 */
import augurContract_df34208a from './reward-policy.contract.js'; /* augur-inject:contract-predicate:d5f27025 */

/** 自動で付く報奨の種類 (本社の調整 `manual` は adjustment-policy が持つ)。 */
export type AutomaticRewardKind = Exclude<RewardKind, "manual">;

export { REWARD_SETTINGS, type RewardTier };

/** 種類 (と重大度) から加算量の段を決める。 段が決まらなければ null。 */
export function rewardTier(kind: AutomaticRewardKind, severity?: BountySeverity | null): RewardTier | null {
  if (kind === "tabula") return "tabula";
  if (kind === "bounty" && severity && `bounty.${severity}` in REWARD_SETTINGS) {
    return `bounty.${severity}` as RewardTier;
  }
  return null;
}

/** 設定値 (文字列) を加算量へ。 読めなければ既定値。 0 は「付けない」設定として尊重する。 */
export function rewardTokens(tier: RewardTier, raw: string | null | undefined): number {
  const fallback = REWARD_SETTINGS[tier].defaultTokens;
  if (raw === null || raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) return fallback;
  return Math.min(value, MAX_TOKENS_PER_ENTRY);
}

export type RewardSkipReason = PersonSkipReason | "invalid_source" | "unknown_tier" | "zero_amount";

export interface RewardInput {
  kind: AutomaticRewardKind;
  sourceRef: string;
  recipient: PersonResolution;
  /** 設定から決めた加算量。 段が決まらなければ null。 */
  tokens: number | null;
  /** 同じ `(kind, source_ref)` で付与済みのトークン数。 未付与なら null。 */
  alreadyGranted: number | null;
}

export type RewardDecision =
  | { action: "grant"; identity: PersonIdentity; tokens: number }
  | { action: "existing"; tokens: number }
  | { action: "skip"; reason: RewardSkipReason };

const SOURCE_REF = /^[A-Za-z0-9_.:-]{1,160}$/;

export function decideReward(input: RewardInput): RewardDecision {
  if (!SOURCE_REF.test(input.sourceRef)) return { action: "skip", reason: "invalid_source" };
  // 同じ根拠の再送は同じ行を返す (CC-PBUDGET-INV-04)。 加算量の設定が変わっても遡って変えない。
  if (input.alreadyGranted !== null) return { action: "existing", tokens: input.alreadyGranted };
  if (!input.recipient.ok) return { action: "skip", reason: input.recipient.reason };
  if (input.tokens === null) return { action: "skip", reason: "unknown_tier" };
  if (!Number.isInteger(input.tokens) || input.tokens <= 0) return { action: "skip", reason: "zero_amount" };
  return { action: "grant", identity: input.recipient.identity, tokens: Math.min(input.tokens, MAX_TOKENS_PER_ENTRY) };
}
// @ts-expect-error augur-inject
decideReward = contract(decideReward, { ...augurContract_df34208a, contractId: 'pbudget-C-4', mode: 'observe', sample: 1, where: 'src/personal-budget/reward-policy.ts:62', rule: 'contract-wrap', id: 'df34208a' }); /* augur-inject:contract-wrap:df34208a */

/** 取り消すトークン数。 未使用ぶん (今の残高) を上限にし、 残高を負にしない。 */
export function revokeTokens(input: { grantedTokens: number; rewardBalance: number }): number {
  const granted = Number.isFinite(input.grantedTokens) && input.grantedTokens > 0 ? Math.floor(input.grantedTokens) : 0;
  const balance = Number.isFinite(input.rewardBalance) && input.rewardBalance > 0 ? Math.floor(input.rewardBalance) : 0;
  return Math.min(granted, balance);
}

export const REWARD_SKIP_LABEL: Record<RewardSkipReason, string> = {
  head_office: "受取人が本社所属のため付けない",
  no_requester: "受取人を特定できないため付けない",
  invalid_identity: "受取人を特定できないため付けない",
  invalid_source: "根拠 (source_ref) が不正",
  unknown_tier: "加算量の段が決まらない",
  zero_amount: "加算量が 0",
};
