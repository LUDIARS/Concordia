// @spec 新規起動セッションのGitフック
/** Remove only Cc's injected slot, retaining later host/sandbox Git settings. */
export function restoreInheritedGitEnvironment(source) {
  const env = { ...source };
  const index = Number(env.CONCORDIA_SESSION_HOOK_CONFIG_INDEX);
  const count = Number(env.GIT_CONFIG_COUNT);
  if (!/^\d+$/.test(env.CONCORDIA_SESSION_HOOK_CONFIG_INDEX ?? '') || !/^\d+$/.test(env.GIT_CONFIG_COUNT ?? '') || !Number.isInteger(index) || index < 0
    || !Number.isInteger(count) || count <= index || count > 128
    || env[`GIT_CONFIG_KEY_${index}`]?.toLowerCase() !== 'core.hookspath') {
    throw new Error('Git hook environment is inconsistent; operation blocked.');
  }
  for (let slot = 0; slot < count; slot++) {
    const key = env[`GIT_CONFIG_KEY_${slot}`];
    const value = env[`GIT_CONFIG_VALUE_${slot}`];
    if (typeof key !== 'string' || !key || typeof value !== 'string') throw new Error('Git configuration entry is missing; operation blocked.');
    if (slot > index && key.toLowerCase() === 'core.hookspath') throw new Error('A later Git configuration overrides the Cc hook path; operation blocked.');
  }
  for (let slot = index; slot < count - 1; slot++) {
    env[`GIT_CONFIG_KEY_${slot}`] = env[`GIT_CONFIG_KEY_${slot + 1}`];
    env[`GIT_CONFIG_VALUE_${slot}`] = env[`GIT_CONFIG_VALUE_${slot + 1}`];
  }
  delete env[`GIT_CONFIG_KEY_${count - 1}`];
  delete env[`GIT_CONFIG_VALUE_${count - 1}`];
  env.GIT_CONFIG_COUNT = String(count - 1);
  return env;
}
