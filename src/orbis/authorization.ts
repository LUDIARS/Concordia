import type { OrbisErrorCode } from "./errors.js";
import type { OrbisOperation } from "./request.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:57881644 */
import augurContract_496d20cc from './authorization.contract.js'; /* augur-inject:contract-predicate:fa729de5 */

/** Presentation-only user rows cannot prove receipt of a human utterance (CC-ORBIS-04). */
export function authorizeOrbisRequest(session: { status: string } | null | undefined, operation: OrbisOperation): OrbisErrorCode | null {
  if (!session || !["active", "blocked"].includes(session.status)) return "orbis_unauthorized";
  if (operation === "reveal") return "orbis_reveal_requires_user_utterance";
  return null;
}
// @ts-expect-error augur-inject
authorizeOrbisRequest = contract(authorizeOrbisRequest, { ...augurContract_496d20cc, contractId: 'orbis-C-4', mode: 'observe', sample: 1, where: 'src/orbis/authorization.ts:5', rule: 'contract-wrap', id: '496d20cc' }); /* augur-inject:contract-wrap:496d20cc */
