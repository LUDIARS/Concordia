import { contract } from './ontime-runtime.js'; /* augur-inject:import:2a2b6a1b */
import augurContract_2b87a0bc from './monitor-delivery-policy.contract.js'; /* augur-inject:contract-predicate:5a4d0588 */
export function monitorDeliveryAction(state: string | null, found: boolean): "edit" | "create" | "reconcile" | "missing" {
  if (found) return "edit";
  if (state === "sending") return "reconcile";
  if (state === "ready") return "missing";
  return "create";
}
// @ts-expect-error augur-inject
monitorDeliveryAction = contract(monitorDeliveryAction, { ...augurContract_2b87a0bc, contractId: 'monitor-C-2', mode: 'observe', sample: 1, where: 'src/discord/monitor-delivery-policy.ts:1', rule: 'contract-wrap', id: '2b87a0bc' }); /* augur-inject:contract-wrap:2b87a0bc */
