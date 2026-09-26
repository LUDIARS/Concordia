import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createDefinition, inspectDefinition, listDefinitions, runDefinition, verifyDefinition } from './service.mjs';
import { dispatch } from './cli.mjs';
import { atomicJson, digest } from './storage.mjs';

let repo;
const input = () => ({ id: 'greet', description: '日本語の入力を保持する', arguments: [{ name: 'name', required: true }], requiredPermissions: ['workspace-read'], script: 'export const greet = name => `Hello ${name}`;\nif (process.argv[2]) process.stdout.write(greet(JSON.parse(process.argv[2]).name));\n', test: 'import { test } from "node:test";\nimport { strict as assert } from "node:assert";\nimport { greet } from "./script.mjs";\ntest("greets", () => assert.equal(greet("世界"), "Hello 世界"));\n' });
const success = () => ({ status: 'success', exitCode: 0, stdout: '', stderr: '' });
const folder = () => join(repo, 'tools/generated-scripts/greet');

beforeEach(async () => { repo = await fs.mkdtemp(join(tmpdir(), 'cc-script-')); });
afterEach(async () => {
  const target = relative(tmpdir(), repo);
  if (!target.startsWith('cc-script-') || /[/\\]/.test(target)) throw new Error('Unsafe fixture cleanup');
  await fs.rm(repo, { recursive: true, force: true });
});

describe('script creator and command lifecycle', () => {
  it('creates without executing, retries identically and preserves conflicting definitions', async () => {
    const created = await createDefinition(repo, input());
    expect(created.created).toBe(true);
    expect((await inspectDefinition(repo, 'greet')).verified).toBe(false);
    expect((await createDefinition(repo, input())).created).toBe(false);
    await expect(createDefinition(repo, { ...input(), script: 'throw new Error()' })).rejects.toThrow('Conflicting');
    expect((await listDefinitions(repo))[0].digest).toBe(created.digest);
    await expect(fs.stat(join(folder(), 'verification.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('runs actual Node tests and preserves literal Japanese/shell-like input through the shared CLI', async () => {
    const created = await createDefinition(repo, input());
    const verified = await dispatch('script:verify', ['--repo', repo, '--id', 'greet', '--digest', created.digest]);
    expect(verified.status).toBe('success');
    const argsFile = join(repo, 'args.json');
    await fs.writeFile(argsFile, JSON.stringify({ name: '世界; $(exit)' }), 'utf8');
    const result = await dispatch('script:run', ['--repo', repo, '--id', 'greet', '--digest', created.digest, '--run-id', 'first', '--arguments', argsFile]);
    expect(result.status).toBe('success');
    expect(result.stdout).toBe('Hello 世界; $(exit)');
  });
  it('rejects unverified and changed definitions before executing', async () => {
    const created = await createDefinition(repo, input());
    const execute = vi.fn(success);
    await expect(runDefinition(repo, 'greet', created.digest, { name: 'x' }, 'first', { execute })).rejects.toThrow();
    await verifyDefinition(repo, 'greet', created.digest, { execute });
    execute.mockClear();
    await fs.appendFile(join(folder(), 'script.mjs'), '// changed');
    await expect(runDefinition(repo, 'greet', created.digest, { name: 'x' }, 'first', { execute })).rejects.toThrow('changed');
    const current = await inspectDefinition(repo, 'greet');
    expect(current.verified).toBe(false);
    await expect(runDefinition(repo, 'greet', current.digest, { name: 'x' }, 'first', { execute })).rejects.toThrow('verification');
    expect(execute).not.toHaveBeenCalled();
  });
  it('invalidates a prior successful receipt when verification fails or throws', async () => {
    const created = await createDefinition(repo, input());
    await verifyDefinition(repo, 'greet', created.digest, { execute: success });
    await verifyDefinition(repo, 'greet', created.digest, { execute: () => ({ status: 'failed', exitCode: 1 }) });
    expect((await inspectDefinition(repo, 'greet')).verified).toBe(false);
    await expect(verifyDefinition(repo, 'greet', created.digest, { execute: () => { throw new Error('spawn'); } })).rejects.toThrow('spawn');
    expect((await inspectDefinition(repo, 'greet')).verified).toBe(false);
    await expect(fs.stat(join(folder(), '.operation.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('does not replay a completed run and rejects different input using the same ID', async () => {
    const created = await createDefinition(repo, input());
    await verifyDefinition(repo, 'greet', created.digest, { execute: success });
    const execute = vi.fn(success);
    await runDefinition(repo, 'greet', created.digest, { name: 'one' }, 'same', { execute });
    const replay = await runDefinition(repo, 'greet', created.digest, { name: 'one' }, 'same', { execute });
    expect(replay.replayed).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
    await expect(runDefinition(repo, 'greet', created.digest, { name: 'two' }, 'same', { execute })).rejects.toThrow('different input');
  });
  it('returns unknown for interrupted or active receipts without removing their lock or rerunning', async () => {
    const created = await createDefinition(repo, input());
    await fs.mkdir(join(folder(), 'runs'));
    await atomicJson(join(folder(), 'runs/interrupted.json'), { status: 'started', requestDigest: digest({ definition: created.digest, args: { name: 'one' } }) });
    await fs.writeFile(join(folder(), '.operation.lock'), 'active-or-interrupted');
    const execute = vi.fn(success);
    const result = await runDefinition(repo, 'greet', created.digest, { name: 'one' }, 'interrupted', { execute });
    expect(result.status).toBe('unknown');
    expect(execute).not.toHaveBeenCalled();
    await expect(verifyDefinition(repo, 'greet', created.digest, { execute })).rejects.toThrow('locked');
  });
  it('stores unknown after an execution error and never automatically retries it', async () => {
    const created = await createDefinition(repo, input());
    await verifyDefinition(repo, 'greet', created.digest, { execute: success });
    const execute = vi.fn(() => { throw new Error('connection lost'); });
    await expect(runDefinition(repo, 'greet', created.digest, { name: 'one' }, 'lost', { execute })).rejects.toThrow('connection lost');
    expect((await runDefinition(repo, 'greet', created.digest, { name: 'one' }, 'lost', { execute })).status).toBe('unknown');
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('rejects hard-linked command code and directory junctions', async () => {
    await createDefinition(repo, input());
    const code = join(folder(), 'script.mjs');
    await fs.link(code, join(repo, 'linked.mjs'));
    await expect(inspectDefinition(repo, 'greet')).rejects.toThrow('regular file');
    const elsewhere = join(repo, 'outside');
    await fs.mkdir(elsewhere);
    await fs.symlink(elsewhere, join(repo, 'tools/generated-scripts/escape'), 'junction');
    await expect(inspectDefinition(repo, 'escape')).rejects.toThrow('link');
  });
  it('fails closed on malformed CLI options and input files', async () => {
    await expect(dispatch('script:list', [])).rejects.toThrow('--repo');
    await expect(dispatch('script:run', ['--repo', repo, '--shell', 'cmd'])).rejects.toThrow('Invalid option');
    await expect(dispatch('script:create', ['--repo', repo])).rejects.toThrow('--request');
  });
});
