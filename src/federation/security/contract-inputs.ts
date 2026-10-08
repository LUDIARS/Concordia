/** Pure observed shapes: predicates must not import their wrapped I/O/policy modules. */
interface GrantObservation { action: string; resource: string }
export interface ClaimsObservation {
  claims: { kind: string; sub: string; aud: string; iat: string; exp: string; grants: readonly GrantObservation[] };
  subject: string; audience: string; action: string; resource: string; now: number;
  allowed: readonly (GrantObservation & { subject: string })[];
}
export interface ProofObservation {
  publicKey: string; signature: string;
  parts: { method: string; path: string; timestamp: number; nonce: string; body: string; audience: string; token: string };
}
export type AuthorizationObservation = { ok: false } | { ok: true; subject: string; expiresAt: number };
export interface AuthorizationInputObservation {
  config: object | null; headers: Record<string, string | undefined>;
  isCurrent(): boolean; now(): number;
}
