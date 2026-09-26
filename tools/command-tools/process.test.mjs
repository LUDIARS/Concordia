import { expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { executeNode } from './process.mjs';

it('returns failed for nonzero exit and preserves UTF-8 across byte chunks', async () => {
  const result = await executeNode({ cwd: tmpdir(), argv: ['-e', 'const b=Buffer.from("日本語");for(const c of b) process.stdout.write(Buffer.from([c]));process.exitCode=7;'] });
  expect(result.status).toBe('failed');
  expect(result.exitCode).toBe(7);
  expect(result.stdout).toBe('日本語');
});

it('bounds a hung process and reports an uncertain outcome rather than safe-to-retry failure', async () => {
  const result = await executeNode({ cwd: tmpdir(), argv: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 200 });
  expect(result.status).toBe('unknown');
  expect(result.reason).toBe('timeout');
});

it('bounds output and removes interruption listeners', async () => {
  const before = process.listenerCount('SIGINT');
  const result = await executeNode({ cwd: tmpdir(), argv: ['-e', 'setInterval(()=>process.stdout.write("x".repeat(10000)),1)'], outputLimit: 100 });
  expect(result.status).toBe('unknown');
  expect(result.stdout.length).toBeLessThanOrEqual(100);
  expect(result.reason).toBe('output-limit');
  expect(process.listenerCount('SIGINT')).toBe(before);
});
