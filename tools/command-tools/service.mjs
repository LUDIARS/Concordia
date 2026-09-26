// @spec Cc script creator lifecycle
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { requireDigest, validateArguments, validateId } from './contract.mjs';
import { atomicJson, digest, directory, loadDefinition, locked, readJson, registry } from './storage.mjs';
import { executeNode } from './process.mjs';

export { createDefinition } from './storage.mjs';

export async function inspectDefinition(repo, id) {
  const loaded = await loadDefinition(repo, id);
  let receipt = null;
  try { receipt = await readJson(join(loaded.path, 'verification.json')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { ...loaded.definition.manifest, digest: loaded.digest, verified: receipt?.digest === loaded.digest && receipt?.status === 'success' };
}

export async function listDefinitions(repo) {
  let base;
  try { base = await registry(repo); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const entries = await fs.readdir(base, { withFileTypes: true });
  const result = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue;
    result.push(await inspectDefinition(repo, entry.name));
  }
  return result;
}

export async function verifyDefinition(repo, id, expectedDigest, { execute = executeNode, now = () => new Date().toISOString() } = {}) {
  const initial = await loadDefinition(repo, id);
  return locked(initial.path, async () => {
    const loaded = await loadDefinition(repo, id);
    requireDigest(loaded.digest, expectedDigest);
    // Invalidate a previous success before invoking potentially failing tests.
    await atomicJson(join(loaded.path, 'verification.json'), { digest: loaded.digest, status: 'started', observedAt: now() });
    const result = await execute({ cwd: loaded.path, argv: ['--test', 'script.test.mjs'] });
    const after = await loadDefinition(repo, id);
    requireDigest(after.digest, loaded.digest);
    const receipt = { ...result, digest: loaded.digest, observedAt: now() };
    await atomicJson(join(loaded.path, 'verification.json'), receipt);
    return receipt;
  });
}

function priorRun(record, requestDigest) {
  if (record.requestDigest !== requestDigest) throw new Error('Run ID already belongs to different input');
  return record.status === 'started' ? { ...record, status: 'unknown', reason: 'interrupted-or-active', replayed: false } : { ...record, replayed: false };
}

export async function runDefinition(repo, id, expectedDigest, values, runId, { execute = executeNode, now = () => new Date().toISOString() } = {}) {
  validateId(runId);
  const initial = await loadDefinition(repo, id);
  requireDigest(initial.digest, expectedDigest);
  const args = validateArguments(initial.definition.manifest, values);
  const requestDigest = digest({ definition: initial.digest, args });
  const runs = await directory(initial.path, 'runs', true);
  const recordPath = join(runs, `${runId}.json`);
  try { return priorRun(await readJson(recordPath), requestDigest); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return locked(initial.path, async () => {
    const loaded = await loadDefinition(repo, id);
    requireDigest(loaded.digest, expectedDigest);
    try { return priorRun(await readJson(recordPath), requestDigest); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const verified = await readJson(join(loaded.path, 'verification.json'));
    if (verified.digest !== loaded.digest || verified.status !== 'success') throw new Error('Successful verification of this definition is required');
    const started = { id, runId, requestDigest, digest: loaded.digest, status: 'started', startedAt: now() };
    await atomicJson(recordPath, started);
    try {
      const result = await execute({ cwd: loaded.path, argv: ['script.mjs', JSON.stringify(args)] });
      const completed = { ...started, ...result, completedAt: now() };
      await atomicJson(recordPath, completed);
      return completed;
    } catch (error) {
      // The started receipt remains authoritative if saving an outcome fails.
      const unknown = { ...started, status: 'unknown', reason: 'execution-or-result-storage-error', completedAt: now() };
      await atomicJson(recordPath, unknown);
      throw error;
    }
  });
}
