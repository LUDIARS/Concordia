import { z } from 'zod';
import { contract } from './ontime-runtime.js'; /* augur-inject:import:21c1715c */
import augurContract_a8653f94 from './claims.contract.js'; /* augur-inject:contract-predicate:7dd312c3 */

export const WorkloadId = z.string().regex(/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/).max(200);
export const Action = z.enum(['ai-spawn', 'ai-inject', 'hq-config']);
export const Grant = z.object({ action: Action, resource: z.string().min(1).max(400) }).strict();
export const InboundGrant = Grant.extend({ subject: WorkloadId });
export const Claims = z.object({
  kind: z.literal('workload'), sub: WorkloadId, aud: WorkloadId,
  iat: z.string().datetime(), exp: z.string().datetime(), jti: z.string().min(1).max(200),
  cnf: z.object({ public_key: z.string().min(1).max(2048) }).strict(),
  grants: z.array(Grant).max(200),
}).strict();
export type WorkloadClaims = z.infer<typeof Claims>;
export interface ClaimsInput {
  claims: WorkloadClaims;
  subject: string;
  audience: string;
  action: z.infer<typeof Action>;
  resource: string;
  allowed: readonly z.infer<typeof InboundGrant>[];
  now: number;
}

/** Pure intersection of administrator policy and authenticated authority claims. */
export function authorizeWorkloadClaims(input: ClaimsInput): boolean {
  const c = input.claims;
  const issued = Date.parse(c.iat);
  const expires = Date.parse(c.exp);
  return c.kind === 'workload' && c.sub === input.subject && c.aud === input.audience
    && Number.isFinite(input.now) && issued <= input.now && expires > input.now
    && expires > issued && expires - issued <= 60_000
    && input.allowed.some(g => g.subject === c.sub && g.action === input.action && g.resource === input.resource)
    && c.grants.some(g => g.action === input.action && g.resource === input.resource);
}
// @ts-expect-error augur-inject
authorizeWorkloadClaims = contract(authorizeWorkloadClaims, { ...augurContract_a8653f94, contractId: 'cc-security-C-21', mode: 'observe', sample: 1, where: 'src/federation/security/claims.ts:25', rule: 'contract-wrap', id: 'a8653f94' }); /* augur-inject:contract-wrap:a8653f94 */
