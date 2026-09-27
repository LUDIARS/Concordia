import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectCodeRow } from "../db/project-codes-repo.js";
import { repositoryKey } from "../taskflow/actio-binding.js";
import { resolveWorktreeContext } from "./worktree-context.js";
import { WorktreeRecord } from "./worktree-metadata.js";
import { inspectImplementationRepo } from "./repo-context.js";
import { mainRepositoryKey } from "../taskflow/repository-identity.js";

/** Switching means selecting an existing owned checkout, preserving all uncommitted files. */
export async function selectOwnedWorktree(input: { sessionId: string; projectCode: string; branch: string; task: string },
  projects: readonly ProjectCodeRow[], roots: readonly string[]): Promise<string> {
  const context = await resolveWorktreeContext(input, projects, roots);
  const owner = createHash("sha256").update(input.sessionId).digest("hex");
  const file = join(context.worktree, ".local", "concordia", "worktree.json");
  for (const path of [context.worktree, join(context.worktree, ".local"), join(context.worktree, ".local", "concordia"), file]) {
    if ((await lstat(path)).isSymbolicLink()) throw new Error("linked worktree metadata refused");
  }
  const record = WorktreeRecord.parse(JSON.parse(await readFile(file, "utf8")));
  const actual = await inspectImplementationRepo(context.worktree);
  if (record.owner !== owner || record.branch !== input.branch || actual.branch !== input.branch
    || record.projectCode !== context.project.code
    || repositoryKey(record.worktree) !== repositoryKey(await realpath(context.worktree))
    || repositoryKey(record.mainRepo) !== repositoryKey(context.mainRepo)
    || await mainRepositoryKey(context.worktree) !== repositoryKey(context.mainRepo)) throw new Error("worktree ownership mismatch");
  return context.worktree;
}
