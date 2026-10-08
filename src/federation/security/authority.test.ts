import { afterEach, describe, expect, it, vi } from 'vitest';
import { introspectWorkload, issueWorkloadToken } from './authority.js';
import { securityFixture } from './test-fixtures.js';
import { WorkloadTokenInactiveError } from './authority-errors.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe('Cr workload adapter', () => {
  it('uses receiver credentials, exact audience and no cache/redirect', async () => {
    const f = securityFixture();
    vi.stubEnv('TEST_CC_ID', 'receiver'); vi.stubEnv('TEST_CC_SECRET', 'test-secret');
    const fetcher = vi.fn(async () => Response.json({ active: true, claims: f.claims }));
    vi.stubGlobal('fetch', fetcher);
    await introspectWorkload(f.config, 'token'); await introspectWorkload(f.config, 'token');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenLastCalledWith(new URL(f.config.authority.introspectionUrl), expect.objectContaining({
      redirect: 'error', body: JSON.stringify({ token: 'token', audience: 'site-b/concordia', client_id: 'receiver', client_secret: 'test-secret' }),
    }));
  });
  it('rejects inactive, oversized, failing and non-HTTPS authority replies', async () => {
    const f = securityFixture();
    vi.stubEnv('TEST_CC_ID', 'receiver'); vi.stubEnv('TEST_CC_SECRET', 'test-secret');
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    fetcher.mockResolvedValueOnce(Response.json({ active: false }));
    await expect(introspectWorkload(f.config, 'token')).rejects.toBeInstanceOf(WorkloadTokenInactiveError);
    fetcher.mockResolvedValueOnce(new Response('x'.repeat(128 * 1024 + 1)));
    await expect(introspectWorkload(f.config, 'token')).rejects.toThrow('too_large');
    fetcher.mockResolvedValueOnce(new Response('unavailable', { status: 503 }));
    await expect(issueWorkloadToken(f.config, 'site-b/concordia', 'ai-spawn', 'thread:1:2')).rejects.toThrow();
    f.config.authority.introspectionUrl = 'http://cr.example/introspect';
    await expect(introspectWorkload(f.config, 'token')).rejects.toThrow('https');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
