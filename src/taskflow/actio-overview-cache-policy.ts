import { contract } from './ontime-runtime.js'; /* augur-inject:import:122e828f */
import augurContract_cd1c378f from './actio-overview-cache-policy.contract.js'; /* augur-inject:contract-predicate:819860a7 */
/** @implements spec/feature/taskflow-failure-visibility.md CC-TF-READ-03 */
export function selectActioOverviewSnapshot<T extends { complete: boolean }>(
  previous: T | undefined, candidate: T, revision: number, currentRevision: number,
): T | undefined {
  if (revision !== currentRevision || (previous?.complete && !candidate.complete)) return previous;
  return candidate;
}
// @ts-expect-error augur-inject
selectActioOverviewSnapshot = contract(selectActioOverviewSnapshot, { ...augurContract_cd1c378f, contractId: 'actio-read-cache-C-1', mode: 'observe', sample: 1, where: 'src/taskflow/actio-overview-cache-policy.ts:2', rule: 'contract-wrap', id: 'cd1c378f' }); /* augur-inject:contract-wrap:cd1c378f */
