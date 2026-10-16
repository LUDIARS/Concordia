import { contract } from './ontime-runtime.js'; /* augur-inject:import:82455b49 */
import augurContract_3b767fc4 from './conflux-fixture-git.contract.ts'; /* augur-inject:contract-predicate:ed4c6e6e */
/** Command scope outranks inherited GIT_CONFIG_COUNT and GIT_CONFIG_PARAMETERS. */
export function confluxFixtureGitArgs(args: string[], hooks: string): string[] {
  return ["-c", `core.hooksPath=${hooks}`, ...args];
}
// @ts-expect-error augur-inject
confluxFixtureGitArgs = contract(confluxFixtureGitArgs, { ...augurContract_3b767fc4, contractId: 'conflux-fixture-C-1', mode: 'observe', sample: 1, where: 'tests/harness-reliability/conflux-fixture-git.ts:2', rule: 'contract-wrap', id: '3b767fc4' }); /* augur-inject:contract-wrap:3b767fc4 */
