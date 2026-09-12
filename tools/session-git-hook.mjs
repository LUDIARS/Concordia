// @implements spec/feature/shared-startup-context.md — enforce push before forwarding existing Git hooks
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { restoreInheritedGitEnvironment } from './session-git-hook-env.mjs';

const hook = process.argv[2];
const args = process.argv.slice(3);
let env;
try { env = restoreInheritedGitEnvironment(process.env); } catch (error) {
  process.stderr.write(`[Cc hook] ${error.message}\n`);
  process.exit(1);
}
const git = (values) => execFileSync('git', values, { env, encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const receivesInput = ['pre-push', 'post-rewrite', 'reference-transaction'].includes(hook);
const input = receivesInput ? readFileSync(0) : undefined;
let inputDirectory;
let inputPath;
try {
  if (hook === 'pre-push') {
    const port = Number(process.env.LICTOR_PORT);
    const ccPort = Number(process.env.CONCORDIA_PORT);
    if (![port, ccPort].every((value) => Number.isInteger(value) && value > 0 && value < 65536)) throw new Error('Cc/Lictor address is unavailable');
    const read = async (url, options = {}) => {
      const response = await fetch(url, { ...options, signal: AbortSignal.timeout(120000) });
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
  // Removing only our injected config restores global/local hook precedence and LFS behavior.
  // git hook run closes stdin by default; --to-stdin preserves pre-push/LFS ref input.
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
  process.exitCode = result.status ?? 1;
} catch (error) {
  process.stderr.write(`[Cc hook] ${error.message}\n`);
  process.exitCode = 1;
} finally {
  if (inputPath) { try { unlinkSync(inputPath); } catch { /* Retain the original hook result. */ } }
  if (inputDirectory) { try { rmdirSync(inputDirectory); } catch { /* Never recursively remove a directory. */ } }
}
