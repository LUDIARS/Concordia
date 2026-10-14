/**
 * 相談の公開に付ける報奨の依頼 (spec/feature/personal-ai-budget.md §4 の `tabula`)。
 *
 * - 依頼するのは Tabula への投稿が成功して published になった公開候補だけ。 投稿の失敗・公開しない・
 *   取り下げ・期限切れでは依頼しない (相談しただけでは付けない)。
 * - 根拠は公開候補の id、 受取人は相談者。 加算量・一意性・本社所属の見送りは personal-ai-budget が決める
 *   (CC-PBUDGET-INV-04 / 07)。 consultation から台帳を直接書かない。
 *
 * @implements SPEC-PBUDGET-REWARD
 * @implements SPEC-CONSULT-TABULA
 */

import type { ConsultationPublicationRow } from "../db/consultation-publications-repo.js";
import type { PrivateConsultationRow } from "../db/private-consultations-repo.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:6164e07e */
import augurContract_396f0317 from './publication-reward.contract.js'; /* augur-inject:contract-predicate:0d9b6d32 */

export interface TabulaRewardRequest {
  kind: "tabula";
  sourceRef: string;
  recipient: { subsidiaryId: string | null; platform: "discord"; platformUserId: string };
}

/** 個人の AI 予算の報奨の口 (personal-budget/reward-service.ts の PersonalBudgetRewardPort と同じ形)。 */
export interface ConsultationRewardPort {
  requestReward(request: TabulaRewardRequest):
    | { status: "granted" | "existing"; entry: { tokens: number } }
    | { status: "skipped"; reason: string; detail: string };
}

/** 公開済みの候補なら報奨の依頼を作る。 それ以外は null。 */
export function publicationRewardRequest(
  publication: Pick<ConsultationPublicationRow, "id" | "status" | "consultation_id">,
  consultation: Pick<PrivateConsultationRow, "id" | "subsidiary_id" | "requester_user_id">,
): TabulaRewardRequest | null {
  if (publication.status !== "published") return null;
  if (publication.consultation_id !== consultation.id) return null;
  // 相談は Discord の相談チャンネルで受けるので、 相談者は Discord のユーザー。
  return {
    kind: "tabula",
    sourceRef: publication.id,
    recipient: {
      subsidiaryId: consultation.subsidiary_id,
      platform: "discord",
      platformUserId: consultation.requester_user_id,
    },
  };
}
// @ts-expect-error augur-inject
publicationRewardRequest = contract(publicationRewardRequest, { ...augurContract_396f0317, contractId: 'consult-reward-C-1', mode: 'observe', sample: 1, where: 'src/consultation/publication-reward.ts:30', rule: 'contract-wrap', id: '396f0317' }); /* augur-inject:contract-wrap:396f0317 */
