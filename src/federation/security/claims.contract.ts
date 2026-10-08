import type { ClaimsObservation } from './contract-inputs.js';
export default { post(result: boolean, input: ClaimsObservation): boolean {
  if (!result) return true;
  const c = input.claims;
  return c.kind === 'workload' && c.sub === input.subject && c.aud === input.audience
    && Date.parse(c.iat) <= input.now && Date.parse(c.exp) > input.now
    && Date.parse(c.exp) - Date.parse(c.iat) <= 60_000
    && input.allowed.some(g => g.subject === c.sub && g.action === input.action && g.resource === input.resource)
    && c.grants.some(g => g.action === input.action && g.resource === input.resource);
} };
