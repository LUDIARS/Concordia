import { contract } from './ontime-runtime.js'; /* augur-inject:import:e8457f86 */
import augurContract_d7ebe722 from './errors.contract.js'; /* augur-inject:contract-predicate:8835b9fe */
export const ORBIS_ERRORS = ["orbis_token_missing", "orbis_unavailable", "orbis_unauthorized",
  "orbis_operation_failed", "orbis_invalid_request", "orbis_reveal_requires_user_utterance"] as const;
export type OrbisErrorCode = typeof ORBIS_ERRORS[number];

export class OrbisError extends Error {
  constructor(readonly code: OrbisErrorCode) { super(code); this.name = "OrbisError"; }
}

/** Never forward SDK error messages, causes, URLs or response bodies. */
export function publicOrbisError(error: unknown): OrbisErrorCode {
  return error instanceof OrbisError && ORBIS_ERRORS.includes(error.code) ? error.code : "orbis_operation_failed";
}
// @ts-expect-error augur-inject
publicOrbisError = contract(publicOrbisError, { ...augurContract_d7ebe722, contractId: 'orbis-C-3', mode: 'observe', sample: 1, where: 'src/orbis/errors.ts:10', rule: 'contract-wrap', id: 'd7ebe722' }); /* augur-inject:contract-wrap:d7ebe722 */
