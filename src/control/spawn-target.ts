/**
 * Resolve optional branch/worktree spawn targets before launching Lictor.
 *
 * A branch request should not switch the caller's current checkout. When
 * worktree mode is enabled, Concordia creates or reuses a linked worktree for
 * that branch and returns it as the effective cwd.
 */

import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GIT_BIN = process.platform === "win32" ? "git.exe" : "git";
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

export type SpawnTargetGitRunner = (cwd: string, args: string[]) => Promise<string>;

export interface SpawnTargetRequest {
  cwd?: string;
  branch?: unknown;
  worktree?: unknown;
  worktreeBaseDir?: string | null;
  git?: SpawnTargetGitRunner;
}

export interface SpawnTargetOk {
  ok: true;
  cwd?: string;
  branch: string | null;
  worktree: boolean;
  worktree_path: string | null;
  worktree_created: boolean;
}

export interface SpawnTargetErr {
  ok: false;
  error: string;
}

export type SpawnTargetResult = SpawnTargetOk | SpawnTargetErr;

export function parseSpawnBranch(value: unknown): { ok: true; branch: string | null } | SpawnTargetErr {
  if (value === undefined || value === null) return { ok: true, branch: null };
  if (typeof value !== "string") return { ok: false, error: "branch must be a string" };
  const branch = value.trim();
  if (!branch) return { ok: true, branch: null };
  const invalid =
    !BRANCH_RE.test(branch) ||
    branch.startsWith("-") ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch.includes("..") ||
    branch.includes("@{") ||
    branch.includes("//") ||
    branch.split("/").some((part) => !part || part === "." || part.endsWith(".lock"));
  if (invalid) return { ok: false, error: `invalid branch name: ${branch}` };
  return { ok: true, branch };
}

export function parseSpawnWorktree(value: unknown, branch: string | null): boolean {
  if (!branch) return false;
  if (value === undefined || value === null || value === "") return true;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (["0", "false", "no", "off", "none"].includes(v)) return false;
    if (["1", "true", "yes", "on", "worktree"].includes(v)) return true;
  }
  return true;
}

export function branchWorktreeName(repoPath: string, branch: string): string {
  const repoName = basename(repoPath).replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
  const branchSlug =
    branch.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) ||
    "branch";
  return `${repoName}-${branchSlug}`;
}

export async function prepareSpawnTarget(input: SpawnTargetRequest): Promise<SpawnTargetResult> {
  const parsedBranch = parseSpawnBranch(input.branch);
  if (!parsedBranch.ok) return parsedBranch;
  const branch = parsedBranch.branch;
  const worktree = parseSpawnWorktree(input.worktree, branch);
  const cwd = input.cwd?.trim() || undefined;
  if (!branch || !worktree) {
    return { ok: true, cwd, branch, worktree: false, worktree_path: null, worktree_created: false };
  }
  if (!cwd) {
    return { ok: false, error: "branch worktree requires cwd or project" };
  }

  const git = input.git ?? defaultGit;
  let repoRoot: string;
  try {
    repoRoot = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  } catch (err) {
    return { ok: false, error: `cwd is not a git repository: ${messageOf(err)}` };
  }
  if (!repoRoot) return { ok: false, error: "cwd is not a git repository" };

  const existing = await findWorktreeForBranch(git, repoRoot, branch);
  if (existing) {
    return {
      ok: true,
      cwd: existing,
      branch,
      worktree: true,
      worktree_path: existing,
      worktree_created: false,
    };
  }

  const baseDir = input.worktreeBaseDir?.trim() || dirname(repoRoot);
  const worktreePath = join(baseDir, branchWorktreeName(repoRoot, branch));
  if (existsSync(worktreePath)) {
    try {
      if (!statSync(worktreePath).isDirectory()) {
        return { ok: false, error: `worktree path exists and is not a directory: ${worktreePath}` };
      }
      const targetBranch = (await git(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
      if (targetBranch === branch) {
        return {
          ok: true,
          cwd: worktreePath,
          branch,
          worktree: true,
          worktree_path: worktreePath,
          worktree_created: false,
        };
      }
      return {
        ok: false,
        error: `worktree path already exists for branch ${targetBranch || "unknown"}: ${worktreePath}`,
      };
    } catch (err) {
      return { ok: false, error: `worktree path is not usable: ${messageOf(err)}` };
    }
  }

  const localBranch = await refExists(git, repoRoot, `refs/heads/${branch}`);
  const remoteBranch = localBranch ? false : await refExists(git, repoRoot, `refs/remotes/origin/${branch}`);
  const args = localBranch
    ? ["worktree", "add", worktreePath, branch]
    : remoteBranch
      ? ["worktree", "add", "-b", branch, worktreePath, `origin/${branch}`]
      : ["worktree", "add", "-b", branch, worktreePath, "HEAD"];
  try {
    await git(repoRoot, args);
  } catch (err) {
    return { ok: false, error: `failed to create worktree: ${messageOf(err)}` };
  }

  return {
    ok: true,
    cwd: worktreePath,
    branch,
    worktree: true,
    worktree_path: worktreePath,
    worktree_created: true,
  };
}

async function defaultGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(GIT_BIN, ["-C", cwd, ...args], {
    timeout: 15_000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
}

async function refExists(git: SpawnTargetGitRunner, cwd: string, ref: string): Promise<boolean> {
  try {
    await git(cwd, ["show-ref", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

async function findWorktreeForBranch(
  git: SpawnTargetGitRunner,
  cwd: string,
  branch: string,
): Promise<string | null> {
  let stdout: string;
  try {
    stdout = await git(cwd, ["worktree", "list", "--porcelain"]);
  } catch {
    return null;
  }
  let currentPath: string | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length).trim();
      continue;
    }
    if (line.startsWith("branch ")) {
      const currentBranch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
      if (currentBranch === branch) return currentPath;
    }
  }
  return null;
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
