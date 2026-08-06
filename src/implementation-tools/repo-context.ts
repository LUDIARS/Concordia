import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 5_000;

export interface ImplementationRepoContext {
  repoPath: string;
  repoOrigin: string | null;
  branch: string;
}

/** True when a real path remains under one of the configured workspace roots. */
export async function isWithinWorkspace(path: string, workspaceRoots: readonly string[]): Promise<boolean> {
  const candidate = await realpath(path).catch(() => null);
  if (!candidate) return false;
  for (const root of workspaceRoots) {
    const workspaceRoot = await realpath(root).catch(() => null);
    if (!workspaceRoot) continue;
    const rel = relative(resolve(workspaceRoot), candidate);
    if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) return true;
  }
  return false;
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", cwd, ...args], {
    windowsHide: true,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 64 * 1024,
    encoding: "utf8",
  });
  return result.stdout.trim();
}

export async function inspectImplementationRepo(cwd: string): Promise<ImplementationRepoContext> {
  const requested = cwd.trim();
  if (!requested || !isAbsolute(requested)) throw new Error("cwd must be an absolute repository path");
  const repoPath = resolve(await git(requested, ["rev-parse", "--show-toplevel"]));
  const [branch, repoOrigin] = await Promise.all([
    git(repoPath, ["branch", "--show-current"]),
    git(repoPath, ["remote", "get-url", "origin"]).catch(() => null),
  ]);
  if (!branch) throw new Error("implementation tooling requires a named checkout branch");
  return { repoPath, repoOrigin: repoOrigin || null, branch };
}
