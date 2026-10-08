import type { AuthorizationObservation, AuthorizationInputObservation } from './contract-inputs.js';
export default { post(result: AuthorizationObservation, input: AuthorizationInputObservation): boolean {
  return !result.ok || (input.config !== null && input.isCurrent()
    && result.subject === input.headers['x-excubitor-workload']
    && result.expiresAt > input.now());
} };
