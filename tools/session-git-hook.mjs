// @implements spec/feature/shared-startup-context.md — enforce push before forwarding existing Git hooks
import { execFileSync, spawnSync } from 'node:child_process';
import { accessSync, constants, mkdtempSync, readFileSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { restoreInheritedGitEnvironment } from './session-git-hook-env.mjs';

const receivesInput = ['pre-push', 'post-rewrite', 'reference-transaction'];

function inheritedEnvironmentWithoutGitConfig(source) {
  const env = { ...source };
  const count = Number(env.GIT_CONFIG_COUNT);
  if (Number.isInteger(count) && count >= 0 && count <= 128) {
    for (let slot = 0; slot < count; slot++) {
      delete env[`GIT_CONFIG_KEY_${slot}`];
      delete env[`GIT_CONFIG_VALUE_${slot}`];
    }
  }
  delete env.GIT_CONFIG_COUNT;
  return env;
}

function readGlobalHooksPath(environment) {
  try {
    const configured = execFileSync('git', ['config', '--global', 'core.hooksPath'], {
      env: inheritedEnvironmentWithoutGitConfig(environment), encoding: 'utf8', windowsHide: true,
      timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return configured || join(homedir(), '.git-hooks');
  } catch {
    return join(homedir(), '.git-hooks');
  }
}

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Select only an executable original hook from the global hook directory. */
export function resolveReentryHook(input) {
  // path.join は Windows で区切りを \ に変えるため、契約 (hooksPath/hook) どおり / で連結する
  const candidate = input.hooksPath.replace(/[\\/]+$/, "") + "/" + input.hook;
  return input.isExecutable(candidate) ? candidate : null;
}

/** Run the reentry escape hatch before environment restoration can reject the nested wrapper. */
export async function runSessionGitHook(options) {
  const depth = Number.parseInt(options.environment.CONCORDIA_SESSION_HOOK_DEPTH ?? '0', 10);
  const environment = { ...options.environment,
    CONCORDIA_SESSION_HOOK_DEPTH: String(Number.isInteger(depth) && depth >= 0 ? depth + 1 : 1) };
  if (Number.isInteger(depth) && depth >= 1) {
    const hooksPath = options.readGlobalHooksPath(environment);
    const original = resolveReentryHook({ hooksPath, hook: options.hook, isExecutable: options.isExecutable });
    options.writeStderr(`[Cc hook] reentry: ${options.hook} → ${hooksPath.replace(/[\\/]+$/, "")}/${options.hook}\n`);
    return original === null ? 0 : options.runOriginalHook(original, options.args, environment);
  }
  return options.runManagedHook(options.restoreEnvironment(environment), environment);
}

async function runManagedHook(hook, args, env) {
  const git = (values) => execFileSync('git', values, { env, encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const input = receivesInput.includes(hook) ? readFileSync(0) : undefined;
  let inputDirectory;
  let inputPath;
  try {
    if (hook === 'pre-push') {
      const port = Number(process.env.LICTOR_PORT);
      const ccPort = Number(process.env.CONCORDIA_PORT);
      if (![port, ccPort].every((value) => Number.isInteger(value) && value > 0 && value < 65536)) throw new Error('Cc/Lictor address is unavailable');
      const read = async (url, options = {}) => {
        const response = await fetch(url, { ...options, signal: AbortSignal.timeout(660000) });
        if (!response.ok) throw new Error(`Policy request failed (${response.status})`);
        return response.json();
      };
      const session = await read(`http://127.0.0.1:${port}/v1/concordia/session`);
      if (typeof session.session_id !== 'string' || !session.session_id) throw new Error('Session identity unavailable');
      // Git supplies resolved object IDs, including zero IDs for create/delete; never infer them from command text.
      const updates = input.toString('utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => {
        const fields = line.split(' ');
        if (fields.length !== 4) throw new Error('Invalid Git pre-push input');
        const [localRef, localSha, remoteRef, remoteSha] = fields;
        return { localRef, localSha, remoteRef, remoteSha };
      });
      const result = await read(`http://127.0.0.1:${ccPort}/v1/sessions/${encodeURIComponent(session.session_id)}/push-check`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: git(['rev-parse', '--show-toplevel']),
          ...(updates.length ? { push: { remoteName: args[0], remoteUrl: args[1], updates } } : {}) }),
      });
      if (result.allowed !== true) throw new Error(result.reason || 'Push is not allowed by the project workflow');
    }
    if (input !== undefined) {
      inputDirectory = mkdtempSync(join(tmpdir(), 'cc-hook-input-'));
      inputPath = join(inputDirectory, 'stdin');
      writeFileSync(inputPath, input, { mode: 0o600 });
    }
    const result = spawnSync('git', ['hook', 'run', '--ignore-missing',
      ...(inputPath ? [`--to-stdin=${inputPath}`] : []), hook, '--', ...args], {
      env, stdio: ['inherit', 'inherit', 'inherit'], windowsHide: true,
    });
    if (result.error) throw result.error;
    return result.status ?? 1;
  } finally {
    if (inputPath) { try { unlinkSync(inputPath); } catch { /* Retain the original hook result. */ } }
    if (inputDirectory) { try { rmdirSync(inputDirectory); } catch { /* Never recursively remove a directory. */ } }
  }
}

async function main() {
  const hook = process.argv[2];
  const args = process.argv.slice(3);
  try {
    process.exitCode = await runSessionGitHook({
      hook, args, environment: process.env, restoreEnvironment: restoreInheritedGitEnvironment,
      readGlobalHooksPath, isExecutable,
      // runSessionGitHook は (restoredEnv, environment) で呼ぶ。hook 名と引数はここで閉じ込める
      // (直接渡すと hook に env が入り `args is not iterable` で全 ref 更新が止まる)。
      runManagedHook: (env) => runManagedHook(hook, args, env),
      runOriginalHook: (path, originalArgs, env) => {
        const result = spawnSync(path, originalArgs, { env, stdio: ['inherit', 'inherit', 'inherit'], windowsHide: true });
        if (result.error) throw result.error;
        return result.status ?? 1;
      },
      writeStderr: (line) => process.stderr.write(line),
    });
  } catch (error) {
    process.stderr.write(`[Cc hook] ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
