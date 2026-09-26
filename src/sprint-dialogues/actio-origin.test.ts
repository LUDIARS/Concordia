import { expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { readSprintActioOrigin } from './actio-origin.js';
vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }));
it('uses only the owning catalog public origin and rejects credentials or missing configuration', async () => {
  vi.mocked(readFile).mockResolvedValueOnce('services:\n - code: actio\n   env:\n     ACTIO_CF_PUBLIC_ORIGIN: https://actio.example\n');
  expect(await readSprintActioOrigin('E:/workspace')).toBe('https://actio.example');
  vi.mocked(readFile).mockResolvedValueOnce('services: []');
  await expect(readSprintActioOrigin('E:/workspace')).rejects.toThrow('未設定');
  vi.mocked(readFile).mockResolvedValueOnce('services:\n - code: actio\n   env:\n     ACTIO_CF_PUBLIC_ORIGIN: https://user:secret@actio.example\n');
  await expect(readSprintActioOrigin('E:/workspace')).rejects.toThrow('不正');
});
