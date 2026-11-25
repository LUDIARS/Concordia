/** @implements spec/feature/taskflow-failure-visibility.md CC-TF-READ-01 */
import { contract } from './ontime-runtime.js'; /* augur-inject:import:55a0bebd */
import augurContract_6ed46c8a from './actio-request-failure.contract.js'; /* augur-inject:contract-predicate:65eb8385 */

export function classifyActioRequestFailure(
  method: "GET" | "POST" | "PATCH", timedOut: boolean, invalidJson: boolean,
): string {
  if (method !== "GET") return "Actio task request outcome unknown; reconcile using the same task identity";
  if (timedOut) return "Actio read timed out";
  if (invalidJson) return "Invalid Actio read response";
  return "Actio read connection failed";
}
// @ts-expect-error augur-inject
classifyActioRequestFailure = contract(classifyActioRequestFailure, { ...augurContract_6ed46c8a, contractId: 'actio-overview-C-1', mode: 'observe', sample: 1, where: 'src/taskflow/actio-request-failure.ts:2', rule: 'contract-wrap', id: '6ed46c8a' }); /* augur-inject:contract-wrap:6ed46c8a */
