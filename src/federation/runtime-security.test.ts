import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFederationRuntime } from './runtime.js';
import { makeTestDb } from '../../tests/helpers/db.js';
import { SecretBox } from '../shared/secret-box.js';
import { readFederationEnv } from './env.js';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe('remote target denial without local fallback', () => {
  it('does not turn an unavailable remote spawn or ingress into a local request', () => {
    vi.stubEnv('CONCORDIA_WORKLOAD_SECURITY_FILE', '');
    // Runtime may refresh Villa site metadata; this boundary test never contacts another service.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('synthetic_villa_unavailable'); }));
    const db = makeTestDb();
    const runtime = createFederationRuntime({ db, secretBox: new SecretBox(Buffer.alloc(32, 7)),
      version: 'test', env: readFederationEnv({}) });
    try {
      runtime.apiDeps.sites.create({ siteId: 'site-a', name: 'Remote' });
      runtime.apiDeps.sites.setDepartments('site-a', ['12345']);
      expect(() => runtime.routeForumSpawn({ guildId: '12345', channelId: '67890', authorId: null,
        title: '@site-a test', body: 'task', runtimeRules: [], appliedTagNames: [] })).toThrow('remote_spawn_unavailable');
      expect(runtime.routeIngress({ guild_id: '12345', channel_id: '67890', message_id: '88888',
        author_id: '11111', author_label: 'test', text: 'reply', ts: 1 })).toBe(true);
    } finally { runtime.stop(); db.close(); }
  });
});
