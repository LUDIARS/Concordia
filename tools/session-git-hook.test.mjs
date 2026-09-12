import { expect, it, vi } from 'vitest';
import { runSessionGitHook } from './session-git-hook.mjs';

const hook = 'pre-push';

function fixture(patch = {}) {
  const calls = { managed: [], original: [], stderr: [] };
  const options = {
    hook, args: ['origin', 'main'], environment: { CONCORDIA_SESSION_HOOK_DEPTH: '0' },
    restoreEnvironment: vi.fn((environment) => ({ ...environment, restored: 'yes' })),
    readGlobalHooksPath: vi.fn(() => '/global-hooks'),
    isExecutable: vi.fn(() => false),
    runManagedHook: vi.fn((environment) => { calls.managed.push(environment); return 17; }),
    runOriginalHook: vi.fn((path, args, environment) => { calls.original.push({ path, args, environment }); return 23; }),
    writeStderr: (line) => calls.stderr.push(line),
    ...patch,
  };
  return { calls, options };
}

it('uses restored Git configuration during the first wrapper invocation', async () => {
  const { calls, options } = fixture();
  await expect(runSessionGitHook(options)).resolves.toBe(17);
  expect(options.restoreEnvironment).toHaveBeenCalledOnce();
  expect(options.readGlobalHooksPath).not.toHaveBeenCalled();
  expect(calls.managed).toEqual([expect.objectContaining({ CONCORDIA_SESSION_HOOK_DEPTH: '1', restored: 'yes' })]);
});

it('runs the executable global hook on reentry and preserves arguments', async () => {
  const { calls, options } = fixture({ environment: { CONCORDIA_SESSION_HOOK_DEPTH: '1' }, isExecutable: vi.fn((path) => path === '/global-hooks/pre-push') });
  await expect(runSessionGitHook(options)).resolves.toBe(23);
  expect(options.restoreEnvironment).not.toHaveBeenCalled();
  expect(calls.original).toEqual([{ path: '/global-hooks/pre-push', args: ['origin', 'main'], environment: expect.objectContaining({ CONCORDIA_SESSION_HOOK_DEPTH: '2' }) }]);
  expect(calls.stderr).toEqual(['[Cc hook] reentry: pre-push → /global-hooks/pre-push\n']);
});

it('returns success without an executable global hook on reentry', async () => {
  const { calls, options } = fixture({ environment: { CONCORDIA_SESSION_HOOK_DEPTH: '1' } });
  await expect(runSessionGitHook(options)).resolves.toBe(0);
  expect(options.restoreEnvironment).not.toHaveBeenCalled();
  expect(calls.original).toEqual([]);
  expect(calls.stderr).toEqual(['[Cc hook] reentry: pre-push → /global-hooks/pre-push\n']);
});
