import { describeTaskflowFailure } from "../taskflow/failure.js";
import { failureTeamCandidates } from "../taskflow/actio-team-selection.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:4e1a3c45 */
import augurContract_86e4232b from './seal-failure.contract.js'; /* augur-inject:contract-predicate:7a357c4b */

/** Kept verbatim for callers that match the historical error text. */
export const SEAL_FAILURE_ERROR = "Actio task registration or execution claim failed; inspect the existing task/run before retry";

export interface SealFailureDetail {
  code: string;
  message: string;
  candidate_team_ids?: string[];
  hint?: string;
}

/** Pure mapping from a seal exception to a safe, actionable invoke detail. */
export function describeSealFailure(error: unknown): SealFailureDetail {
  const failure = describeTaskflowFailure(error);
  const candidates = failureTeamCandidates(error);
  if (candidates.length === 0) return { code: failure.code, message: failure.message };
  return {
    code: failure.code, message: failure.message, candidate_team_ids: [...candidates],
    hint: "actio_team_id に候補チーム ID のいずれかを指定して再実行してください。",
  };
}
// @ts-expect-error augur-inject
describeSealFailure = contract(describeSealFailure, { ...augurContract_86e4232b, contractId: 'actio-team-C-1', mode: 'observe', sample: 1, where: 'src/delegation/seal-failure.ts:15', rule: 'contract-wrap', id: '86e4232b' }); /* augur-inject:contract-wrap:86e4232b */
