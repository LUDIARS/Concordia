import { realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ProjectCodeRow } from "../db/project-codes-repo.js";
import { repositoryKey } from "../taskflow/actio-binding.js";
import { mainRepositoryKey } from "../taskflow/repository-identity.js";
import { branchWorktreeName, parseSpawnBranch } from "../control/spawn-target.js";
import { normalizeRepoOrigin } from "../pr/normalize.js";
import { inspectImplementationRepo, isWithinWorkspace } from "./repo-context.js";

export interface WorktreeContext { project: ProjectCodeRow; branch: string; mainRepo: string; worktree: string }

function taskBranch(value: string): string {
  const parsed = parseSpawnBranch(value);
  if (!parsed.ok || !parsed.branch || ["main", "master", "develop"].includes(parsed.branch.toLowerCase())) {
    throw new Error("a task branch is required");
  }
  return parsed.branch;
}

async function registeredMain(project: ProjectCodeRow, roots: readonly string[]): Promise<string> {
  const mainRepo = await realpath(project.repo_path);
  if (!await isWithinWorkspace(mainRepo, roots)
    || roots.some(root => repositoryKey(root) === repositoryKey(mainRepo))
    || await mainRepositoryKey(mainRepo) !== repositoryKey(mainRepo)) throw new Error("invalid main repository");
  const context = await inspectImplementationRepo(mainRepo);
  if (repositoryKey(context.repoPath) !== repositoryKey(mainRepo)) throw new Error("registered repository is not a Git root");
  if (project.repo_origin && normalizeRepoOrigin(context.repoOrigin ?? "") !== normalizeRepoOrigin(project.repo_origin)) {
    throw new Error("registered repository origin mismatch");
  }
  return mainRepo;
}

/** Resolve repository identity and permitted allocation paths before any mutation. */
export async function resolveWorktreeContext(
  input: { projectCode: string; branch: string; task: string },
  projects: readonly ProjectCodeRow[], roots: readonly string[],
): Promise<WorktreeContext> {
  const branch = taskBranch(input.branch);
  if (!input.task.trim()) throw new Error("task is required");
  const matches = projects.filter(project => project.code === input.projectCode);
  if (matches.length !== 1) throw new Error("project code is missing or ambiguous");
  const project = matches[0]!;
  const mainRepo = await registeredMain(project, roots);
  const worktree = join(dirname(mainRepo), branchWorktreeName(mainRepo, branch));
  if (!await isWithinWorkspace(dirname(worktree), roots)) throw new Error("worktree must remain inside workspace");
  return { project, branch, mainRepo, worktree };
}
