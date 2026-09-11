import { expect, it } from 'vitest';
import { restoreInheritedGitEnvironment } from './session-git-hook-env.mjs';

const base = { CONCORDIA_SESSION_HOOK_CONFIG_INDEX: '1', GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/original-hooks',
  GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: '/cc-hooks' };

it('restores original hooks and preserves later unrelated Git settings', () => {
  const source = { ...base, GIT_CONFIG_COUNT: '4',
    GIT_CONFIG_KEY_2: 'safe.directory', GIT_CONFIG_VALUE_2: '/repo',
    GIT_CONFIG_KEY_3: 'core.fsmonitor', GIT_CONFIG_VALUE_3: 'false' };
  const restored = restoreInheritedGitEnvironment(source);
  expect(restored).toMatchObject({ GIT_CONFIG_COUNT: '3', GIT_CONFIG_VALUE_0: '/original-hooks',
    GIT_CONFIG_KEY_1: 'safe.directory', GIT_CONFIG_VALUE_1: '/repo',
    GIT_CONFIG_KEY_2: 'core.fsmonitor', GIT_CONFIG_VALUE_2: 'false' });
  expect(restored.GIT_CONFIG_KEY_3).toBeUndefined();
  expect(source.GIT_CONFIG_VALUE_1).toBe('/cc-hooks');
});
it('supports the original tail-slot installation', () => {
  expect(restoreInheritedGitEnvironment(base)).toMatchObject({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_VALUE_0: '/original-hooks' });
});
it('blocks a later hooksPath override', () => {
  expect(() => restoreInheritedGitEnvironment({ ...base, GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_2: 'core.hooksPath', GIT_CONFIG_VALUE_2: '/different-hooks' })).toThrow('overrides');
});
it.each([
  { CONCORDIA_SESSION_HOOK_CONFIG_INDEX: '' }, { GIT_CONFIG_COUNT: '1' },
  { GIT_CONFIG_COUNT: '3' }, { GIT_CONFIG_KEY_1: 'safe.directory' },
])('blocks malformed ownership or incomplete settings: %j', (patch) => {
  expect(() => restoreInheritedGitEnvironment({ ...base, ...patch })).toThrow();
});
