import { describe, expect, it } from 'vitest';
import { authorizeWorkloadClaims, Claims, type ClaimsInput } from './claims.js';
import { securityFixture } from './test-fixtures.js';

describe('Cc workload grants', () => {
  function input(): ClaimsInput {
    const f = securityFixture();
    return { claims: f.claims, subject: f.claims.sub, audience: f.claims.aud,
      now: f.now, action: 'ai-spawn', resource: 'thread:12345:67890', allowed: f.config.inbound };
  }
  it('accepts the exact administrator and Cr grant intersection', () => expect(authorizeWorkloadClaims(input())).toBe(true));
  it.each(['subject', 'audience', 'resource'] as const)('rejects a different %s', key => {
    expect(authorizeWorkloadClaims({ ...input(), [key]: 'other/concordia' })).toBe(false);
  });
  it('separates inject, spawn, HQ configuration and site operational data', () => {
    expect(authorizeWorkloadClaims({ ...input(), action: 'ai-inject' })).toBe(false);
    expect(authorizeWorkloadClaims({ ...input(), action: 'hq-config' })).toBe(false);
    expect(authorizeWorkloadClaims({ ...input(), allowed: [] })).toBe(false);
    const i = input();
    i.claims.grants = [];
    expect(authorizeWorkloadClaims(i)).toBe(false);
  });
  it('rejects future, expired, overlong and malformed claims', () => {
    const i = input();
    expect(authorizeWorkloadClaims({ ...i, now: i.now - 1 })).toBe(false);
    expect(authorizeWorkloadClaims({ ...i, now: i.now + 60_000 })).toBe(false);
    i.claims.exp = new Date(i.now + 60_001).toISOString();
    expect(authorizeWorkloadClaims(i)).toBe(false);
    expect(Claims.safeParse({ ...i.claims, kind: 'service' }).success).toBe(false);
    expect(Claims.safeParse({ ...i.claims, iat: 'yesterday' }).success).toBe(false);
  });
});
