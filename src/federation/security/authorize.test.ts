import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authorizeWorkloadRequest, type AuthorizationInput } from './authorize.js';
import { createWorkloadNonceStore } from './nonce-store.js';
import { workloadProofHeaders } from './proof.js';
import { securityFixture } from './test-fixtures.js';
import { WorkloadTokenInactiveError } from './authority-errors.js';

describe('privileged operation boundary', () => {
  const databases: Database.Database[] = [];
  afterEach(() => { for (const db of databases.splice(0)) db.close(); });
  function request() {
    const f = securityFixture();
    const db = new Database(':memory:'); databases.push(db);
    const introspect = vi.fn(async () => f.claims);
    const parts = { method: 'POST', path: '/federation/event', body: '{"type":"spawn"}',
      audience: f.claims.aud, subject: f.claims.sub, token: 'test-token', now: f.now, privateKey: f.privateKey };
    const input: AuthorizationInput = { ...parts, headers: workloadProofHeaders(parts),
      config: f.config, action: 'ai-spawn', resource: 'thread:12345:67890', introspect,
      nonces: createWorkloadNonceStore(db), now: () => f.now, isCurrent: () => true };
    return { f, db, input, introspect };
  }
  it('checks online on every action and refuses repeated or concurrent proofs', async () => {
    const { input, introspect } = request();
    const results = await Promise.all([authorizeWorkloadRequest(input), authorizeWorkloadRequest(input)]);
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(introspect).toHaveBeenCalledTimes(2);
  });
  it('rejects revocation and authority outage after a previously valid request', async () => {
    const { input, introspect } = request();
    expect((await authorizeWorkloadRequest(input)).ok).toBe(true);
    introspect.mockRejectedValueOnce(new WorkloadTokenInactiveError());
    expect(await authorizeWorkloadRequest(input)).toMatchObject({ ok: false, retryable: false, reason: 'inactive_token' });
    introspect.mockRejectedValueOnce(new Error('fetch failed'));
    expect(await authorizeWorkloadRequest(input)).toMatchObject({ ok: false, retryable: true, reason: 'authority_unavailable' });
  });
  it('rejects missing config, legacy, payload/target changes and malformed token kind', async () => {
    const { input, introspect } = request();
    for (const override of [{ config: null }, { headers: {} }, { body: 'changed' },
      { resource: 'thread:12345:99999' }, { action: 'hq-config' as const }]) {
      expect((await authorizeWorkloadRequest({ ...input, ...override })).ok).toBe(false);
    }
    introspect.mockResolvedValueOnce({ ...input, kind: 'service' } as never);
    expect((await authorizeWorkloadRequest(input)).ok).toBe(false);
  });
  it('rejects expiry or ownership loss during authority I/O', async () => {
    const { input, f } = request();
    let now = f.now;
    expect((await authorizeWorkloadRequest({ ...input, now: () => now,
      introspect: async () => { now += 60_000; return f.claims; } })).ok).toBe(false);
    let current = true;
    expect((await authorizeWorkloadRequest({ ...input, isCurrent: () => current,
      introspect: async () => { current = false; return f.claims; } })).ok).toBe(false);
  });
  it('retains nonce records across adapter reconstruction and denies storage failure', async () => {
    const { db, input } = request();
    expect((await authorizeWorkloadRequest(input)).ok).toBe(true);
    expect(await authorizeWorkloadRequest({ ...input, nonces: createWorkloadNonceStore(db) }))
      .toMatchObject({ ok: false, retryable: false, reason: 'replay' });
    expect(await authorizeWorkloadRequest({ ...input, nonces: { consume() { throw new Error('disk'); } } }))
      .toMatchObject({ ok: false, retryable: true, reason: 'storage_failed' });
  });
});
