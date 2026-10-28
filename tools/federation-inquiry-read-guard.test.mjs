import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, link, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allowInquiryRead } from './federation-inquiry-read-guard.mjs';

const temps = [];
afterEach(async () => { for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture() {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'cc-read-guard-')));
  temps.push(temp);
  const root = join(temp, 'repo'); await mkdir(root);
  await writeFile(join(root, 'source.txt'), 'source', 'utf8');
  await writeFile(join(temp, 'outside.txt'), 'secret', 'utf8');
  return { root, temp };
}
describe('inquiry read guard', () => {
  it('accepts scoped reads and recursive searches, rejects traversal and unknown tools', async () => {
    const { root, temp } = await fixture();
    expect(await allowInquiryRead({ tool_name: 'Read', tool_input: { file_path: 'source.txt' } }, root)).toBe(true);
    expect(await allowInquiryRead({ tool_name: 'Glob', tool_input: { pattern: '**/*.txt' } }, root)).toBe(true);
    expect(await allowInquiryRead({ tool_name: 'Grep', tool_input: { pattern: 'source' } }, root)).toBe(true);
    for (const file_path of ['../outside.txt', join(temp, 'outside.txt'), 'missing']) {
      expect(await allowInquiryRead({ tool_name: 'Read', tool_input: { file_path } }, root)).toBe(false);
    }
    expect(await allowInquiryRead({ tool_name: 'Glob', tool_input: { pattern: '../*' } }, root)).toBe(false);
    expect(await allowInquiryRead({ tool_name: 'Bash', tool_input: { command: 'git show HEAD' } }, root)).toBe(false);
    expect(await allowInquiryRead({ tool_name: 'mcp__outside__read', tool_input: {} }, root)).toBe(false);
    expect(await allowInquiryRead({}, root)).toBe(false);
  });
  it('rejects directory junctions during recursive searches and direct reads', async () => {
    const { root, temp } = await fixture();
    await symlink(temp, join(root, 'escape'), 'junction');
    expect(await allowInquiryRead({ tool_name: 'Read', tool_input: { file_path: 'escape/outside.txt' } }, root)).toBe(false);
    expect(await allowInquiryRead({ tool_name: 'Grep', tool_input: { pattern: 'secret' } }, root)).toBe(false);
    expect(await allowInquiryRead({ tool_name: 'Glob', tool_input: { pattern: '**/*' } }, root)).toBe(false);
  });
  it('rejects hardlinked files', async () => {
    const { root, temp } = await fixture();
    await link(join(temp, 'outside.txt'), join(root, 'linked.txt'));
    expect(await allowInquiryRead({ tool_name: 'Read', tool_input: { file_path: 'linked.txt' } }, root)).toBe(false);
  });
});
