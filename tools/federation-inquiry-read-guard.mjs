/** @implements spec/feature/federation-link.md SPEC-FED-INQUIRY-READ */
import { lstat, realpath, readdir } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export function within(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

// Check every traversed entry: a lexical root check alone cannot constrain recursive tools.
async function checkedTree(root, candidate, recursive, budget) {
  if (--budget.left < 0 || !within(root, candidate)) return false;
  const real = await realpath(candidate);
  if (!within(root, real) || real !== candidate) return false;
  const info = await lstat(candidate);
  if (info.isSymbolicLink()) return false;
  if (info.isFile()) return info.nlink === 1;
  if (!info.isDirectory() || !recursive) return false;
  for (const name of await readdir(candidate)) {
    if (!await checkedTree(root, resolve(candidate, name), true, budget)) return false;
  }
  return true;
}

/** Unknown tools, invalid input, missing paths and links fail closed without disclosing paths. */
export async function allowInquiryRead(input, root) {
  try {
    if (!['Read', 'Grep', 'Glob'].includes(input?.tool_name)) return false;
    if (!isAbsolute(root) || await realpath(root) !== root) return false;
    const fields = input.tool_input;
    if (!fields || typeof fields !== 'object') return false;
    const read = input.tool_name === 'Read';
    const path = read ? fields.file_path : (fields.path ?? root);
    if (typeof path !== 'string' || !path || /[:\0]/.test(path.replace(/^[A-Za-z]:/, ''))) return false;
    // Glob patterns can override their search root. Grep's glob is subject to the same rule.
    const glob = input.tool_name === 'Glob' ? fields.pattern : fields.glob;
    if (glob !== undefined && (typeof glob !== 'string' || !glob
      || /\.\.|[\\:\0]|^[/~]/.test(glob))) return false;
    const candidate = resolve(root, path);
    return await checkedTree(root, candidate, !read, { left: 10_000 });
  } catch {
    return false;
  }
}

export async function main(stream = process.stdin) {
  // Exit with Claude's blocking code before the host hook timeout can become a non-blocking error.
  const watchdog = setTimeout(() => {
    process.stderr.write('Concordia: inquiry scope check timed out.\n');
    process.exit(2);
  }, 8_000);
  try {
    const chunks = []; let size = 0;
    for await (const chunk of stream) {
      size += Buffer.byteLength(chunk);
      if (size > 65_536) throw new Error('input limit');
      chunks.push(Buffer.from(chunk));
    }
    const root = Buffer.from(process.argv[2] ?? '', 'base64url').toString('utf8');
    const allowed = await allowInquiryRead(JSON.parse(Buffer.concat(chunks).toString('utf8')), root);
    if (!allowed) throw new Error('denied');
    process.stdout.write(JSON.stringify({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'allow',
    } }));
  } catch {
    process.stderr.write('Concordia: inquiry read scope could not be verified.\n');
    process.exitCode = 2;
  } finally {
    clearTimeout(watchdog);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
