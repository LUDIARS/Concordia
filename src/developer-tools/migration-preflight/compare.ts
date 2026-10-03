import { contract } from './ontime-runtime.js'; /* augur-inject:import:b4b224fa */
import augurContract_5d3e07d4 from './compare.contract.ts'; /* augur-inject:contract-predicate:25268b58 */
/** A statically read migration definition; no database or schema module is loaded. */
export interface MigrationDefinition {
  readonly version: number;
  readonly name: string;
  readonly definition: string;
}
export interface MigrationCollision {
  version: number;
  leftName: string;
  rightName: string;
}

/** @implements CC-MIGRATION-PREFLIGHT C-13 */
export function compareMigrations(
  left: readonly MigrationDefinition[], right: readonly MigrationDefinition[], ancestor: readonly MigrationDefinition[],
): MigrationCollision[] {
  const previous = new Map(ancestor.map(item => [item.version, item.definition]));
  const peers = new Map(right.map(item => [item.version, item]));
  return left.flatMap(item => {
    const peer = peers.get(item.version);
    if (!peer || peer.definition === item.definition) return [];
    if (previous.get(item.version) === item.definition && previous.get(peer.version) === peer.definition) return [];
    return [{ version: item.version, leftName: item.name, rightName: peer.name }];
  }).sort((a, b) => a.version - b.version);
}
// @ts-expect-error augur-inject
compareMigrations = contract(compareMigrations, { ...augurContract_5d3e07d4, contractId: 'C-13', mode: 'observe', sample: 1, where: 'src/developer-tools/migration-preflight/compare.ts:14', rule: 'contract-wrap', id: '5d3e07d4' }); /* augur-inject:contract-wrap:5d3e07d4 */
