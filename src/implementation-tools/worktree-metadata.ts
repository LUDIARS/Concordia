import { appendFile, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";

export const WorktreeRecord = z.object({
  version: z.literal(1), owner: z.string().regex(/^[a-f0-9]{64}$/),
  projectCode: z.string().min(1), actioProjectId: z.string().min(1),
  mainRepo: z.string().min(1), worktree: z.string().min(1), branch: z.string().min(1),
  baseCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
}).strict();
export type WorktreeRecord = z.infer<typeof WorktreeRecord>;
export type WorktreeGit = (cwd: string, args: string[]) => Promise<string>;

async function metadataDirectory(root: string): Promise<string> {
  const realRoot = await realpath(root);
  let current = realRoot;
  for (const part of [".local", "concordia"]) {
    current = join(current, part);
    await mkdir(current).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    const stat = await lstat(current);
    const rel = relative(realRoot, await realpath(current));
    if (stat.isSymbolicLink() || !stat.isDirectory() || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
      throw new Error("worktree metadata directory is not private to this checkout");
    }
  }
  return current;
}

async function refuseLink(path: string): Promise<void> {
  const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (stat?.isSymbolicLink()) throw new Error("Git exclude must not use a symbolic link");
}

async function excludeMetadata(root: string, git: WorktreeGit): Promise<void> {
  const exclude = resolve(root, (await git(root, ["rev-parse", "--git-path", "info/exclude"])).trim());
  await refuseLink(exclude);
  await refuseLink(dirname(exclude));
  await mkdir(dirname(exclude), { recursive: true });
  const ignored = await readFile(exclude, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  if (!ignored.split(/\r?\n/).includes("/.local/concordia/")) {
    await appendFile(exclude, "\n/.local/concordia/\n", "utf8");
  }
}

async function reserveRecord(file: string, parsed: WorktreeRecord): Promise<WorktreeRecord> {
  try {
    await writeFile(file, JSON.stringify(parsed, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if ((await lstat(file)).isSymbolicLink()) throw new Error("worktree metadata must not be a symbolic link");
  const stored = WorktreeRecord.parse(JSON.parse(await readFile(file, "utf8")));
  // The original base commit survives a retry after local main has advanced.
  if (JSON.stringify({ ...stored, baseCommit: parsed.baseCommit }) !== JSON.stringify(parsed)) {
    throw new Error("worktree is reserved for a different request or session");
  }
  return stored;
}

/** Reserve metadata with exclusive creation; an existing record is never overwritten. */
export async function keepWorktreeRecord(
  root: string, filename: string, record: WorktreeRecord, git: WorktreeGit,
): Promise<WorktreeRecord> {
  if (!/^(?:worktree|allocation-[a-f0-9]{64})\.json$/.test(filename)) throw new Error("invalid worktree metadata name");
  const parsed = WorktreeRecord.parse(record);
  if ((await git(root, ["ls-files", "--", ".local/concordia"])).trim()) {
    throw new Error("worktree metadata must not be tracked");
  }
  const directory = await metadataDirectory(root);
  await excludeMetadata(root, git);
  await git(root, ["check-ignore", "--quiet", "--", `.local/concordia/${filename}`]);
  return reserveRecord(join(directory, filename), parsed);
}
