import { describe, expect, it } from 'vitest';
import { verifyWorkloadProof, workloadProofHeaders, type ProofParts } from './proof.js';
import { securityFixture } from './test-fixtures.js';

describe('Ex compatible Cc request proof', () => {
  it('binds every request component and rejects other keys', () => {
    const f = securityFixture();
    const parts: ProofParts = { method: 'POST', path: '/federation/event', body: '{"type":"spawn"}',
      timestamp: f.now, nonce: '1234567890abcdef', token: 'test-token', audience: f.claims.aud };
    const headers = workloadProofHeaders({ ...parts, now: f.now, privateKey: f.privateKey, subject: f.claims.sub });
    const input = { publicKey: f.claims.cnf.public_key, parts, signature: headers['x-excubitor-signature'] };
    expect(verifyWorkloadProof(input)).toBe(true);
    for (const key of ['method', 'path', 'body', 'nonce', 'token', 'audience'] as const) {
      expect(verifyWorkloadProof({ ...input, parts: { ...parts, [key]: parts[key] + 'changed' } })).toBe(false);
    }
    expect(verifyWorkloadProof({ ...input, parts: { ...parts, timestamp: parts.timestamp + 1 } })).toBe(false);
    expect(verifyWorkloadProof({ ...input, publicKey: securityFixture().claims.cnf.public_key })).toBe(false);
    expect(verifyWorkloadProof({ ...input, signature: 'bad' })).toBe(false);
  });
});
