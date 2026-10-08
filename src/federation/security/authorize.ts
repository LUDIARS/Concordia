import { authorizeWorkloadClaims, Claims, type ClaimsInput } from './claims.js';
import type { WorkloadSecurityConfig } from './config.js';
import type { WorkloadNonceStore } from './nonce-store.js';
import { verifyWorkloadProof } from './proof.js';
import { isWorkloadTokenInactive } from './authority-errors.js';
import type { EventRejectReason, EventRetryReason } from './event-outcome.js';
import { contract } from './ontime-runtime.js'; /* augur-inject:import:fa0db840 */
import augurContract_933ec615 from './authorize.contract.js'; /* augur-inject:contract-predicate:d1cb21d1 */

export type AuthorizationFailure = EventRejectReason | EventRetryReason;
export type AuthorizationResult = { ok: true; subject: string; expiresAt: number }
  | { ok: false; error: 'workload_authorization_denied'; retryable: true; reason: EventRetryReason }
  | { ok: false; error: 'workload_authorization_denied'; retryable: false; reason: EventRejectReason };
export interface AuthorizationInput {
  config: WorkloadSecurityConfig | null;
  headers: Record<string, string | undefined>;
  method: string; path: string; body: string;
  action: ClaimsInput['action']; resource: string;
  introspect(token: string): Promise<unknown>;
  nonces: WorkloadNonceStore;
  now(): number;
  isCurrent(): boolean;
}
const RETRYABLE: ReadonlySet<string> = new Set<EventRetryReason>(['authority_unavailable', 'stale_proof', 'not_current', 'storage_failed']);
function isRetryReason(reason: AuthorizationFailure): reason is EventRetryReason { return RETRYABLE.has(reason); }
/** 拒否理由を残す。retryable は「操作を実行せず、新しい proof で再配送すれば通りうる」ものだけ。 */
function deny(reason: AuthorizationFailure): AuthorizationResult {
  return isRetryReason(reason)
    ? { ok: false, error: 'workload_authorization_denied', retryable: true, reason }
    : { ok: false, error: 'workload_authorization_denied', retryable: false, reason };
}
export async function authorizeWorkloadRequest(input: AuthorizationInput): Promise<AuthorizationResult> {
  const config = input.config;
  if (!config) return deny('unconfigured');
  if (!input.isCurrent()) return deny('not_current');
  if (Buffer.byteLength(input.body, 'utf8') > 64 * 1024) return deny('invalid_envelope');
  const h = input.headers;
  const token = /^Bearer (\S{1,32768})$/.exec(h.authorization ?? '')?.[1];
  const subject = h['x-excubitor-workload'];
  const nonce = h['x-excubitor-nonce'] ?? '';
  const timestamp = Number(h['x-excubitor-ts']);
  if (!token || !subject || h['x-excubitor-auth'] !== 'cr-v1' || h['x-excubitor-audience'] !== config.local.subject
    || !/^\d{13}$/.test(h['x-excubitor-ts'] ?? '') || !/^[a-zA-Z0-9_-]{16,128}$/.test(nonce)) return deny('invalid_envelope');
  // 本社で署名した後に拠点の受信待ちで時間が過ぎたものは、再配送で新しい proof を作れば通る。
  if (Math.abs(input.now() - timestamp) > 30_000) return deny('stale_proof');
  if (!config.inbound.some(g => g.subject === subject && g.action === input.action && g.resource === input.resource)) return deny('grant_mismatch');
  let introspected: unknown;
  try { introspected = await input.introspect(token); }
  catch (e) { return deny(isWorkloadTokenInactive(e) ? 'inactive_token' : 'authority_unavailable'); }
  const parsed = Claims.safeParse(introspected);
  if (!parsed.success) return deny('inactive_token');
  const now = input.now();
  const claims = parsed.data;
  if (!input.isCurrent()) return deny('not_current');
  if (Math.abs(now - timestamp) > 30_000) return deny('stale_proof');
  try {
    if (!authorizeWorkloadClaims({ claims, subject, audience: config.local.subject, action: input.action,
      resource: input.resource, allowed: config.inbound, now })) return deny('grant_mismatch');
    if (!verifyWorkloadProof({ publicKey: claims.cnf.public_key, signature: h['x-excubitor-signature'] ?? '',
      parts: { method: input.method, path: input.path, body: input.body, timestamp, nonce, audience: config.local.subject, token } })) return deny('proof_invalid');
  } catch { return deny('proof_invalid'); }
  const expiresAt = Date.parse(claims.exp);
  let consumed: boolean;
  try { consumed = input.nonces.consume(subject, config.local.subject, nonce, expiresAt, now); }
  catch { return deny('storage_failed'); /* Storage failure must prevent the operation; no legacy fallback. */ }
  if (!consumed) return deny('replay');
  return { ok: true, subject, expiresAt };
}
// @ts-expect-error augur-inject
authorizeWorkloadRequest = contract(authorizeWorkloadRequest, { ...augurContract_933ec615, contractId: 'cc-security-C-24', mode: 'observe', sample: 1, where: 'src/federation/security/authorize.ts:17', rule: 'contract-wrap', id: '933ec615' }); /* augur-inject:contract-wrap:933ec615 */
