import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readWorkloadSecurityConfig, workloadCredential } from './config.js';
import { introspectWorkload, issueWorkloadToken } from './authority.js';
import { workloadProofHeaders } from './proof.js';
import { securityFixture } from './test-fixtures.js';
import { WorkloadTokenInactiveError } from './authority-errors.js';

vi.mock('./config.js', () => ({ readWorkloadSecurityConfig: vi.fn(), workloadCredential: vi.fn() }));
vi.mock('./authority.js', () => ({ introspectWorkload: vi.fn(), issueWorkloadToken: vi.fn() }));

describe('federation event security wiring', () => {
  const databases: Database.Database[] = [];
  afterEach(() => { for (const db of databases.splice(0)) db.close(); vi.restoreAllMocks(); vi.resetAllMocks(); });
  async function setup() {
    // isolate:false shares the cache with federation runtime tests; reload after mocks are registered.
    vi.resetModules();
    const { createWorkloadSecurity } = await import('./runtime.js');
    const f = securityFixture();
    vi.spyOn(Date, 'now').mockReturnValue(f.now);
    vi.mocked(readWorkloadSecurityConfig).mockReturnValue(f.config);
    vi.mocked(introspectWorkload).mockResolvedValue(f.claims);
    vi.mocked(issueWorkloadToken).mockResolvedValue('test-token');
    vi.mocked(workloadCredential).mockReturnValue(f.privateKey);
    const db = new Database(':memory:'); databases.push(db);
    const security = createWorkloadSecurity(db, vi.fn());
    const payload = { type: 'spawn', guild_id: '12345', channel_id: '67890', author_id: null,
      title: 'test', body: 'work', runtime_rules: [], ts: Math.floor(f.now / 1000) };
    const envelope = (value = payload) => {
      const body = JSON.stringify(value);
      return { type: 'workload-event', body, headers: workloadProofHeaders({ body, privateKey: f.privateKey,
        subject: f.claims.sub, audience: f.claims.aud, token: 'test-token', method: 'POST',
        path: '/federation/event', now: f.now }) };
    };
    return { f, db, security, payload, envelope, createWorkloadSecurity };
  }
  it('denies legacy payloads, wrong target and lost connection ownership', async () => {
    const { security, payload, envelope } = await setup();
    expect(await security.authorizeEvent(payload, () => true)).toEqual({ status: 'rejected', reason: 'invalid_envelope' });
    expect(await security.authorizeEvent(envelope({ ...payload, channel_id: '99999' }), () => true))
      .toEqual({ status: 'rejected', reason: 'grant_mismatch' });
    expect(await security.authorizeEvent(envelope(), () => false)).toEqual({ status: 'retry', reason: 'not_current' });
    expect(await security.authorizeEvent(envelope(), () => true)).toEqual({ status: 'accepted', payload });
  });
  it('deduplicates a fresh signed proof after reconstruction, including inject', async () => {
    const { f, db, security, envelope, payload, createWorkloadSecurity } = await setup();
    expect(await security.authorizeEvent(envelope(), () => true)).toEqual({ status: 'accepted', payload });
    const reconstructed = createWorkloadSecurity(db, vi.fn());
    // 処理済みの再配送は ack してよい (重複実行もしない)。
    expect(await reconstructed.authorizeEvent(envelope(), () => true)).toEqual({ status: 'duplicate' });
    f.config.inbound[0].action = 'ai-inject'; f.claims.grants[0].action = 'ai-inject';
    const inject = { type: 'ingress', guild_id: '12345', channel_id: '67890', message_id: '88888',
      author_id: '11111', author_label: 'test', text: 'reply', ts: 1 };
    const body = JSON.stringify(inject);
    const event = () => ({ type: 'workload-event', body, headers: workloadProofHeaders({ body,
      privateKey: f.privateKey, subject: f.claims.sub, audience: f.claims.aud, token: 'test-token',
      method: 'POST', path: '/federation/event', now: f.now }) });
    expect(await reconstructed.authorizeEvent(event(), () => true)).toEqual({ status: 'accepted', payload: inject });
    expect(await reconstructed.authorizeEvent(event(), () => true)).toEqual({ status: 'duplicate' });
  });
  it('signs at delivery time and obtains a separate Cc audience token', async () => {
    const { security, payload } = await setup();
    const sent = await security.prepareEvent('site-b', payload);
    expect(sent).toMatchObject({ type: 'workload-event', body: JSON.stringify(payload) });
    expect(issueWorkloadToken).toHaveBeenCalledWith(expect.any(Object), 'site-b/concordia', 'ai-spawn', 'thread:12345:67890');
    await expect(security.prepareEvent('unknown-site', payload)).rejects.toThrow('unconfigured');
  });
  it('keeps the request for redelivery when Cr is unreachable, and rejects when Cr says inactive', async () => {
    const { security, envelope, payload } = await setup();
    vi.mocked(introspectWorkload).mockRejectedValueOnce(new Error('authority_unavailable'));
    expect(await security.authorizeEvent(envelope(), () => true)).toEqual({ status: 'retry', reason: 'authority_unavailable' });
    vi.mocked(introspectWorkload).mockRejectedValueOnce(new WorkloadTokenInactiveError());
    expect(await security.authorizeEvent(envelope(), () => true)).toEqual({ status: 'rejected', reason: 'inactive_token' });
    // 一時障害の後でも要求台帳は未記録なので、新しい proof の再配送は実行される。
    expect(await security.authorizeEvent(envelope(), () => true)).toEqual({ status: 'accepted', payload });
  });
  it('asks for redelivery when the proof aged while waiting at the site', async () => {
    const { f, security, envelope } = await setup();
    const signed = envelope();
    vi.spyOn(Date, 'now').mockReturnValue(f.now + 31_000);
    expect(await security.authorizeEvent(signed, () => true)).toEqual({ status: 'retry', reason: 'stale_proof' });
  });
  it('keeps remote privilege disabled when configuration is absent', async () => {
    const { db, envelope, createWorkloadSecurity } = await setup();
    vi.mocked(readWorkloadSecurityConfig).mockReturnValue(null);
    const security = createWorkloadSecurity(db, vi.fn());
    expect(await security.authorizeEvent(envelope(), () => true)).toEqual({ status: 'rejected', reason: 'unconfigured' });
    expect(await security.authorizeHq({}, 'PUT', '/v1/federation/site', '{}')).toBe(false);
  });
});
