import { contract } from './ontime-runtime.js'; /* augur-inject:import:4b8efd48 */
import augurContract_cc1e94b3 from './reward-decision.contract.js'; /* augur-inject:contract-predicate:f66b36c9 */
/**
 * 報奨を依頼してよいかの判定 (spec/feature/bug-bounty.md §7)。 純関数。
 *
 * 条件: 判定が採用、重複でない、自己起因でない、受取人が居る、受取人が本社所属でない
 * (CC-BOUNTY-INV-05)。 加算量・一意性・台帳は個人の AI 予算が持ち、ここは依頼の可否だけを決める。
 *
 * @implements SPEC-BOUNTY-REWARD
 */

export type BountyRewardSkip = "not_accepted" | "duplicate" | "self_inflicted" | "no_recipient" | "headquarters";

export const BOUNTY_REWARD_SKIP_LABEL: Record<BountyRewardSkip, string> = {
  not_accepted: "採用されていない報告",
  duplicate: "重複と判定された報告",
  self_inflicted: "報告者自身の変更が原因の報告",
  no_recipient: "報奨を受け取れる個人が居ない (依頼者を特定できない)",
  headquarters: "本社所属の報告者は報奨の対象外",
};

export interface BountyRewardInput {
  verdict: string | null;
  duplicateOf: string | null;
  selfInflicted: boolean;
  /** 受取人 (bounty_reporters の行)。 居なければ null。 */
  recipient: { subsidiaryId: string | null } | null;
}

export type BountyRewardDecision = { request: true } | { request: false; reason: BountyRewardSkip };

export function decideBountyRewardRequest(input: BountyRewardInput): BountyRewardDecision {
  if (input.verdict === "duplicate" || input.duplicateOf !== null) return { request: false, reason: "duplicate" };
  if (input.verdict !== "accepted") return { request: false, reason: "not_accepted" };
  if (input.selfInflicted) return { request: false, reason: "self_inflicted" };
  if (!input.recipient) return { request: false, reason: "no_recipient" };
  if (input.recipient.subsidiaryId === null) return { request: false, reason: "headquarters" };
  return { request: true };
}
// @ts-expect-error augur-inject
decideBountyRewardRequest = contract(decideBountyRewardRequest, { ...augurContract_cc1e94b3, contractId: 'bounty-flow-C-4', mode: 'observe', sample: 1, where: 'src/bounty/reward-decision.ts:30', rule: 'contract-wrap', id: 'cc1e94b3' }); /* augur-inject:contract-wrap:cc1e94b3 */

/** 受付の時点で分かる「報奨の対象外」 (本社所属・受取人なし)。 対象になりうるなら null。 */
export function bountyRewardIneligibility(recipient: { subsidiaryId: string | null } | null): BountyRewardSkip | null {
  if (!recipient) return "no_recipient";
  if (recipient.subsidiaryId === null) return "headquarters";
  return null;
}
