import type { ResourceRelease } from "./execution-adapter.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:5b8171f9 */
import augurContract_0d3b1d33 from './colab-admission.contract.js'; /* augur-inject:contract-predicate:4d1d4cf5 */
import augurContract_1f440d46 from './colab-release.contract.js'; /* augur-inject:contract-predicate:f00dbfc3 */

export interface ColabClassification { code: string; data: string; destination: string }

export function colabAdmission(input: {
  ownerApproved: boolean;
  evidence: ColabClassification;
  ownerDestination: string;
}): boolean {
  return input.ownerApproved && input.evidence.code === "public" && input.evidence.data === "non_confidential"
    && input.evidence.destination === input.ownerDestination;
}
// @ts-expect-error augur-inject
colabAdmission = contract(colabAdmission, { ...augurContract_0d3b1d33, contractId: 'cloud-work-C-1', mode: 'observe', sample: 1, where: 'src/cloud-work/colab-policy.ts:5', rule: 'contract-wrap', id: '0d3b1d33' }); /* augur-inject:contract-wrap:0d3b1d33 */

export function releaseEvidence(allocationResolved: boolean, absent: boolean): ResourceRelease {
  return allocationResolved && absent ? "released" : "unknown";
}
// @ts-expect-error augur-inject
releaseEvidence = contract(releaseEvidence, { ...augurContract_1f440d46, contractId: 'cloud-work-C-3', mode: 'observe', sample: 1, where: 'src/cloud-work/colab-policy.ts:14', rule: 'contract-wrap', id: '1f440d46' }); /* augur-inject:contract-wrap:1f440d46 */
