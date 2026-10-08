import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { localBrowserDecision, type BrowserInput } from './local-browser-policy.js';
import { localBrowserGuard } from './local-browser-guard.js';

const base: BrowserInput = { method: 'POST', url: 'http://127.0.0.1:11111/v1/admin/spawn-session',
  host: '127.0.0.1:11111', origin: undefined, fetchSite: undefined, contentType: 'application/json', allowedOrigins: [] };
describe('local browser boundary', () => {
  it('allows local JSON callers and same-origin UI', () => {
    expect(localBrowserDecision(base)).toBeNull();
    expect(localBrowserDecision({ ...base, origin: 'http://127.0.0.1:11111', fetchSite: 'same-origin' })).toBeNull();
  });
  it.each([
    { host: 'evil.example' }, { host: undefined }, { origin: 'null' }, { origin: 'https://evil.example' },
    { origin: 'http://127.0.0.1:9999' }, { fetchSite: 'cross-site' }, { contentType: 'text/plain' },
    { contentType: 'application/x-www-form-urlencoded' }, { contentType: undefined },
    { host: 'evil.example', url: 'http://evil.example/v1/admin/spawn-session' },
  ])('denies browser bypass %j', override => expect(localBrowserDecision({ ...base, ...override })).not.toBeNull());
  it('requires exact configured origin for Access and dev UI', () => {
    expect(localBrowserDecision({ ...base, host: 'cc.example', url: 'https://cc.example/v1/x',
      origin: 'https://cc.example', allowedOrigins: ['https://cc.example'] })).toBeNull();
  });
  it('guards before route side effects, including bodyless mutations', async () => {
    const app = new Hono(); let called = 0;
    app.use('*', localBrowserGuard([]));
    app.post('/v1/admin/spawn-session', c => { called++; return c.json({ ok: true }); });
    const request = (headers: Record<string, string>) => app.request(base.url, { method: 'POST', headers, body: '{}' });
    expect((await request({ host: base.host!, 'content-type': 'text/plain', origin: 'https://evil.example' })).status).toBe(403);
    expect((await request({ host: base.host! })).status).toBe(415);
    expect(called).toBe(0);
    expect((await request({ host: base.host!, 'content-type': 'application/json' })).status).toBe(200);
    expect(called).toBe(1);
  });
});
