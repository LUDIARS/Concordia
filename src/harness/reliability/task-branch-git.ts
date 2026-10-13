import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

const run = promisify(execFile);
export interface CheckoutBranch { repo: string; branch: string }
export interface BranchSnapshot {
  repo: string;
  branch: string;
  mainExists: boolean;
  /** Shared repository directory; identical for the main checkout and its linked worktrees. */
  commonDir?: string;
  /** Every checkout (main + linked worktrees) of the same repository and its current branch. */
  checkouts?: CheckoutBranch[];
}
type GitRead = (args: string[]) => Promise<string>;

/** Parse `git worktree list --porcelain`; detached or bare entries carry no branch. */
export function parseWorktreeList(output: string): CheckoutBranch[] {
  return output.split(/\r?\n\r?\n/).flatMap((block) => {
    const path = block.match(/^worktree (.+)$/m)?.[1];
    const branch = block.match(/^branch refs\/heads\/(.+)$/m)?.[1];
    return path && branch ? [{ repo: resolve(path.trim()), branch: branch.trim() }] : [];
  });
}

/** Read-only git runner bound to one checkout. */
function gitReader(cwd: string): GitRead {
  return async (args) => (await run("git", ["-C", cwd, ...args], {
    // A repository with many linked worktrees produces a long `worktree list`.
    encoding: "utf8", windowsHide: true, timeout: 3000, maxBuffer: 1_048_576,
  })).stdout.trim();
}

/** Checkout root, current branch and whether a local main exists. */
async function readCheckoutBranch(git: GitRead): Promise<Pick<BranchSnapshot, "repo" | "branch" | "mainExists">> {
  const repo = resolve(await git(["rev-parse", "--show-toplevel"]));
  const branch = await git(["branch", "--show-current"]);
  // --list returns empty for a missing local main without hiding execution errors.
  const mainExists = Boolean(await git(["branch", "--list", "main"]));
  return { repo, branch, mainExists };
}

/** Shared by the main checkout and its linked worktrees, so a worktree is recognised as the same repository. */
async function readCommonDir(git: GitRead, repo: string): Promise<string> {
  return resolve(repo, await git(["rev-parse", "--path-format=absolute", "--git-common-dir"]));
}

async function readCheckouts(git: GitRead): Promise<CheckoutBranch[]> {
  return parseWorktreeList(await git(["worktree", "list", "--porcelain"]));
}

/** Read current Git state at the action boundary; never checkout/stash/reset here. */
export async function readBranchSnapshot(cwd: string): Promise<BranchSnapshot> {
  const git = gitReader(cwd);
  const checkout = await readCheckoutBranch(git);
  return { ...checkout, commonDir: await readCommonDir(git, checkout.repo), checkouts: await readCheckouts(git) };
}
