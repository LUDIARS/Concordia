import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { securityFixture } from './test-fixtures.js';

afterEach(() => vi.unstubAllEnvs());
describe('administrator workload configuration', () => {
  it('requires distinct Cc identities and exact HTTPS authority endpoints', async () => {
    const { SecurityConfig } = await vi.importActual<typeof import('./config.js')>('./config.js');
    const { config } = securityFixture();
    expect(SecurityConfig.parse(config)).toEqual(config);
    for (const changed of [
      { ...config, local: { ...config.local, subject: 'site-b/excubitor' } },
      { ...config, sites: { 'site-b': 'site-b/excubitor' } },
      { ...config, authority: { ...config.authority, tokenUrl: 'http://cr.invalid/token' } },
      { ...config, authority: { ...config.authority, tokenUrl: 'https://user:dummy@cr.invalid/token' } },
      { ...config, inbound: [{ ...config.inbound[0], action: 'vault' }] },
      { ...config, secret: randomBytes(16).toString('hex') },
    ]) expect(SecurityConfig.safeParse(changed).success).toBe(false);
  });
  it('loads only the explicit bounded administrator file and fails on absent credentials', async () => {
    const { readWorkloadSecurityConfig, workloadCredential } = await vi.importActual<typeof import('./config.js')>('./config.js');
    expect(readWorkloadSecurityConfig({})).toBeNull();
    const directory = mkdtempSync(join(tmpdir(), 'cc-security-config-'));
    const path = join(directory, 'config.json');
    try {
      const { config } = securityFixture();
      writeFileSync(path, JSON.stringify(config));
      expect(readWorkloadSecurityConfig({ CONCORDIA_WORKLOAD_SECURITY_FILE: path })).toEqual(config);
      writeFileSync(path, ' '.repeat(256 * 1024 + 1));
      expect(() => readWorkloadSecurityConfig({ CONCORDIA_WORKLOAD_SECURITY_FILE: path })).toThrow('too_large');
      vi.stubEnv('TEST_CC_BOUNDARY_CREDENTIAL', undefined);
      expect(() => workloadCredential('TEST_CC_BOUNDARY_CREDENTIAL')).toThrow('missing');
      const dummy = randomBytes(16).toString('hex');
      vi.stubEnv('TEST_CC_BOUNDARY_CREDENTIAL', dummy);
      expect(workloadCredential('TEST_CC_BOUNDARY_CREDENTIAL')).toBe(dummy);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
