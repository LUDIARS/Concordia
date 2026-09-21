import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { repositoryKey } from "./actio-binding.js";

/** Resolve only Git worktree metadata; never read task content from a clone. */
export async function mainRepositoryKey(repoPath: string): Promise<string> {
  try {
    const marker = await readFile(join(repoPath, ".git"), "utf8");
    const gitdir = /^gitdir:\s*(.+)\s*$/m.exec(marker)?.[1]?.trim();
    if (!gitdir) return repositoryKey(repoPath);
    const metadata = resolve(repoPath, gitdir);
    const common = (await readFile(join(metadata, "commondir"), "utf8")).trim();
    return repositoryKey(dirname(resolve(metadata, common)));
  } catch (error) {
    if (["ENOENT", "EISDIR", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) return repositoryKey(repoPath);
    throw new Error("Task repository identity could not be resolved");
  }
}
