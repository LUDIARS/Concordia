import { contract } from './ontime-runtime.js'; /* augur-inject:import:c6a61e37 */
import augurContract_2bfcd2ae from './merge-return.contract.js'; /* augur-inject:contract-predicate:33d2ad45 */
export interface MergeReturnTarget {
  project_code: string;
  merge_commit_sha: string;
  branch: string;
}

export type MergeReturnDecision = "queued" | "disabled" | "duplicate" | "breaker_open";

export function decideMergeReturn(duplicate: boolean, enabled: boolean, breaker: { status: "OPEN" | "CLOSED" }): MergeReturnDecision {
  if (duplicate) return "duplicate";
  if (!enabled) return "disabled";
  if (breaker.status === "OPEN") return "breaker_open";
  return "queued";
}
// @ts-expect-error augur-inject
decideMergeReturn = contract(decideMergeReturn, { ...augurContract_2bfcd2ae, contractId: 'gen5-return-C-3', mode: 'observe', sample: 1, where: 'src/conflux/merge-return-policy.ts:9', rule: 'contract-wrap', id: '2bfcd2ae' }); /* augur-inject:contract-wrap:2bfcd2ae */

export function mergeReturnKey(target: MergeReturnTarget): string {
  return `merge-return:${target.project_code}:${target.merge_commit_sha}`;
}

export function isMergeCommit(sha: unknown): sha is string {
  return typeof sha === "string" && /^[0-9a-f]{40}$/.test(sha);
}

export function mergeObservationKey(projectCode: string, prId: string, sha: string): string {
  return JSON.stringify([projectCode, prId, sha]);
}
