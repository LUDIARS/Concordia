import { afterEach, describe, expect, it, vi } from 'vitest';
import { getTaskflowOverview, failureGuidance } from './taskflow-failure.js';

afterEach(() => vi.unstubAllGlobals());
describe('safe taskflow read errors', () => {
  it('preserves a known reason without displaying arbitrary response details', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ reason: 'actio_unavailable', message: 'token=secret' }), { status: 503 }));
    vi.stubGlobal('fetch', fetch);
    await expect(getTaskflowOverview('/scoped')).rejects.toMatchObject({ reason: 'actio_unavailable', status: 503 });
    await expect(getTaskflowOverview('/scoped')).rejects.not.toThrow('secret');
    expect(fetch).toHaveBeenCalledWith('/scoped');
  });
  it.each(['secret-value', '__proto__', 'constructor'])('hides unknown reason %s', async (reason) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ reason }), { status: 500 })));
    await expect(getTaskflowOverview('/scoped')).rejects.toMatchObject({ reason: 'taskflow_request_failed' });
    expect(failureGuidance(reason)).not.toContain(reason);
  });
  it('reports a disconnected server without forwarding the exception', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('private endpoint'); }));
    await expect(getTaskflowOverview('/scoped')).rejects.toMatchObject({ reason: 'taskflow_connection_failed' });
  });
});
