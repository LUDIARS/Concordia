import { contract } from './ontime-runtime.js'; /* augur-inject:import:14335e2f */
import augurContract_cae06306 from './receipt.contract.js'; /* augur-inject:contract-predicate:2b69ea85 */
import augurContract_b974ff89 from './build.contract.js'; /* augur-inject:contract-predicate:d34c9091 */
import augurContract_137ceb83 from './integration.contract.js'; /* augur-inject:contract-predicate:cf873174 */
/** @implements spec/feature/conflux-integration.md */

export function receiptMatch(stored: string | undefined, incoming: string): "new" | "same" | "conflict" {
  return stored === undefined ? "new" : stored === incoming ? "same" : "conflict";
}
// @ts-expect-error augur-inject
receiptMatch = contract(receiptMatch, { ...augurContract_cae06306, contractId: 'C-45', mode: 'observe', sample: 1, where: 'src/conflux/policy.ts:3', rule: 'contract-wrap', id: 'cae06306' }); /* augur-inject:contract-wrap:cae06306 */

export interface BuildIdentity {
  projectCode: string;
  variantId: string;
}

export function buildIdentity(key: string, commit: string): BuildIdentity | null {
  const [prefix, projectCode, variantId, sha, retry, ...rest] = key.split(":");
  if (prefix !== "cf-build" || !projectCode || !variantId || sha !== commit || !/^[0-9a-f]{7,40}$/.test(commit)
    || rest.length || (retry !== undefined && !/^retry-[1-9][0-9]*$/.test(retry))) return null;
  return { projectCode, variantId };
}
// @ts-expect-error augur-inject
buildIdentity = contract(buildIdentity, { ...augurContract_b974ff89, contractId: 'C-46', mode: 'observe', sample: 1, where: 'src/conflux/policy.ts:12', rule: 'contract-wrap', id: 'b974ff89' }); /* augur-inject:contract-wrap:b974ff89 */

export interface IntegrationBinding {
  decisionId: string;
  projectCode: string;
  repository: string;
  commit: string;
}

interface IntegrationPr {
  id: string;
  status: string;
  repository: string;
  headSha: string;
  mergeCommitSha?: string | null;
  baseRef?: string;
  updatedAt?: string;
}

export function integrationEvent(binding: IntegrationBinding, pr: IntegrationPr) {
  if (pr.status !== "merged" || pr.repository.toLowerCase() !== binding.repository.toLowerCase()
    || !pr.headSha.startsWith(binding.commit)) return null;
  return {
    source: "revisor" as const,
    outcome: "integrated" as const,
    projectCode: binding.projectCode,
    decisionId: binding.decisionId,
    commit: binding.commit,
    ref: pr.id,
  };
}
// @ts-expect-error augur-inject
integrationEvent = contract(integrationEvent, { ...augurContract_137ceb83, contractId: 'C-47', mode: 'observe', sample: 1, where: 'src/conflux/policy.ts:33', rule: 'contract-wrap', id: '137ceb83' }); /* augur-inject:contract-wrap:137ceb83 */
