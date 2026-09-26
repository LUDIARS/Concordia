// @spec Cc script creator storage and recovery
import * as fs from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { validateDefinition, validateId } from './contract.mjs';

export function digest(value) {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

export async function directory(parent, name, create = false) {
  const path = join(parent, name);
  if (create) await fs.mkdir(path).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const stat = await fs.lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Registry directory must not be a link');
  const real = await fs.realpath(path);
  const rel = relative(parent, real);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Registry path escapes repository');
  return real;
}

export async function registry(repo, create = false) {
  const root = await fs.realpath(repo);
  const tools = await directory(root, 'tools', create);
  return directory(tools, 'generated-scripts', create);
}

export async function readText(path) {
  const stat = await fs.lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1_048_576) throw new Error('Expected bounded regular file');
  return fs.readFile(path, 'utf8');
}

export async function readJson(path) {
  return JSON.parse((await readText(path)).replace(/^\uFEFF/, ''));
}

export async function atomicJson(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temp, 'wx');
    try {
      await handle.writeFile(JSON.stringify(value, null, 2) + '\n', 'utf8');
      await handle.sync();
    } finally { await handle.close(); }
    await fs.rename(temp, path);
  } finally {
    await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function loadDefinition(repo, id) {
  validateId(id);
  const path = await directory(await registry(repo), id);
  const manifest = await readJson(join(path, 'manifest.json'));
  if (manifest.version !== 1 || manifest.id !== id) throw new Error('Unsupported or mismatched manifest');
  const { version: _version, ...fields } = manifest;
  const definition = validateDefinition({ ...fields, script: await readText(join(path, 'script.mjs')), test: await readText(join(path, 'script.test.mjs')) });
  return { path, definition, digest: digest(definition) };
}

/** A crash leaves the exclusive lock for explicit operator reconciliation. */
export async function locked(path, work) {
  const lockPath = join(path, '.operation.lock');
  let handle;
  try { handle = await fs.open(lockPath, 'wx'); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Command is locked; reconcile active/interrupted operation before removing lock');
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), 'utf8');
    return await work();
  } finally {
    await handle.close();
    await fs.unlink(lockPath);
  }
}

export async function createDefinition(repo, input) {
  const definition = validateDefinition(input);
  const base = await registry(repo, true);
  const id = definition.manifest.id;
  // Lock the registry while publishing; rename must never replace an existing definition.
  return locked(base, async () => {
    try {
      const existing = await loadDefinition(repo, id);
      if (existing.digest !== digest(definition)) throw new Error('Conflicting existing definition');
      return { id, digest: existing.digest, created: false };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const target = join(base, id);
    // Reject even a partially written pre-existing definition.
    try { await fs.lstat(target); throw new Error('Existing incomplete definition requires reconciliation'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const temp = await fs.mkdtemp(join(base, '.create-'));
    try {
      await atomicJson(join(temp, 'manifest.json'), definition.manifest);
      await fs.writeFile(join(temp, 'script.mjs'), definition.script, 'utf8');
      await fs.writeFile(join(temp, 'script.test.mjs'), definition.test, 'utf8');
      await fs.rename(temp, target);
    } finally {
      // Only this function's freshly allocated staging directory can be removed.
      const stagingRelative = relative(base, temp);
      if (!stagingRelative.startsWith('.create-') || stagingRelative.includes('/') || stagingRelative.includes('\\')) {
        throw new Error('Unexpected staging path');
      }
      await fs.rm(temp, { recursive: true, force: true });
    }
    return { id, digest: digest(definition), created: true };
  });
}
