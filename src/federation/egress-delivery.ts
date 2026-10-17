/** @implements spec/feature/federation-link.md CC-FED-EGRESS-MENTION-01 */
import type { FederationEgressDelivery, FederationEgressRequestFrame } from "./protocol.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:1dd216dd */
import augurContract_ca63d8ae from './egress-delivery.contract.js'; /* augur-inject:contract-predicate:93900522 */

/** Only HQ may supply mention IDs; the wire schema preserves unknown fields for compatibility. */
export function prepareEgressDelivery(request: FederationEgressRequestFrame, mentionUserId: string | undefined): FederationEgressDelivery {
  const { mention_user_id: _siteMention, ...delivery } = request;
  return { ...delivery, ...(mentionUserId ? { mention_user_id: mentionUserId } : {}) };
}
// @ts-expect-error augur-inject
prepareEgressDelivery = contract(prepareEgressDelivery, { ...augurContract_ca63d8ae, contractId: 'fed-egress-C-1', mode: 'observe', sample: 1, where: 'src/federation/egress-delivery.ts:5', rule: 'contract-wrap', id: 'ca63d8ae' }); /* augur-inject:contract-wrap:ca63d8ae */
