import { expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSprintActioOrigin } from './actio-origin.js';

// The suite shares one module cache (vitest isolate: false), so a vi.mock of node:fs/promises
// is ignored whenever another test file loaded actio-origin first. Use a real catalog file instead.
function workspaceWithCatalog(yaml: string): string {
  const root = mkdtempSync(join(tmpdir(), 'cc-actio-origin-'));
  mkdirSync(join(root, 'Actio'), { recursive: true });
  writeFileSync(join(root, 'Actio', 'excubitor.catalog.yaml'), yaml, 'utf8');
  return root;
}

it('uses only the owning catalog public origin and rejects credentials or missing configuration', async () => {
  expect(await readSprintActioOrigin(workspaceWithCatalog('services:\n - code: actio\n   env:\n     ACTIO_CF_PUBLIC_ORIGIN: https://actio.example\n'))).toBe('https://actio.example');
  await expect(readSprintActioOrigin(workspaceWithCatalog('services: []'))).rejects.toThrow('未設定');
  await expect(readSprintActioOrigin(workspaceWithCatalog('services:\n - code: actio\n   env:\n     ACTIO_CF_PUBLIC_ORIGIN: https://user:secret@actio.example\n'))).rejects.toThrow('不正');
});
