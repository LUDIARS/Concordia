import { generateKeyPairSync } from 'node:crypto';
import type { WorkloadSecurityConfig } from './config.js';
import type { WorkloadClaims } from './claims.js';

export function securityFixture(): { config: WorkloadSecurityConfig; claims: WorkloadClaims; privateKey: string; now: number } {
  const now = Date.parse('2026-10-07T00:00:00.000Z');
  const pair = generateKeyPairSync('ed25519');
  const grant = { action: 'ai-spawn' as const, resource: 'thread:12345:67890' };
  return {
    now, privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    config: {
      local: { subject: 'site-b/concordia', clientIdEnv: 'TEST_CC_ID', clientSecretEnv: 'TEST_CC_SECRET', privateKeyEnv: 'TEST_CC_KEY' },
      authority: { tokenUrl: 'https://cr.example/token', introspectionUrl: 'https://cr.example/introspect' },
      inbound: [{ subject: 'site-a/concordia', ...grant }], sites: { 'site-b': 'site-b/concordia' },
    },
    claims: { kind: 'workload', sub: 'site-a/concordia', aud: 'site-b/concordia',
      iat: new Date(now).toISOString(), exp: new Date(now + 60_000).toISOString(), jti: 'test-token',
      cnf: { public_key: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() }, grants: [grant] },
  };
}
