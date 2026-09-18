import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import type { ConfluxSelection } from "./conflux-policy.js";
const run = promisify(execFile);
export interface ConfluxGitState { repo: string; branch: string; dedicated: boolean; dirty: boolean; baseExists: boolean; workExists: boolean; descends: boolean }
const git = async (cwd: string, args: string[]): Promise<string> => (await run("git", ["-C", cwd, ...args], {
  encoding: "utf8", windowsHide: true, timeout: 5000, maxBuffer: 262144,
})).stdout.trim();
export async function inspectConfluxGit(cwd: string, selection: ConfluxSelection): Promise<ConfluxGitState> {
  const repo = resolve(await git(cwd, ["rev-parse", "--show-toplevel"]));
  const branch = await git(repo, ["branch", "--show-current"]);
  const dir = await git(repo, ["rev-parse", "--path-format=absolute", "--git-dir"]);
  const common = await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const dirty = Boolean(await git(repo, ["status", "--porcelain", "--untracked-files=all"]));
  const baseExists = Boolean(await git(repo, ["branch", "--list", selection.baseBranch]));
  const workExists = Boolean(await git(repo, ["branch", "--list", selection.workBranch]));
  let descends = false;
  if (baseExists && workExists) {
    const base = await git(repo, ["rev-parse", "refs/heads/" + selection.baseBranch]);
    descends = await git(repo, ["merge-base", "refs/heads/" + selection.baseBranch, "refs/heads/" + selection.workBranch]) === base;
  }
  return { repo, branch, dedicated: resolve(dir) !== resolve(common), dirty, baseExists, workExists, descends };
}
/** Git refuses a branch used by another worktree. Never force, reset, stash or clean. */
export async function switchConfluxGit(cwd: string, selection: ConfluxSelection, exists: boolean): Promise<void> {
  await git(cwd, exists ? ["switch", selection.workBranch] : ["switch", "-c", selection.workBranch, selection.baseBranch]);
}
