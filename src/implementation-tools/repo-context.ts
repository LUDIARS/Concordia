import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { ImplementationBindFailure } from "./bind-failure.js";

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
  try {
    const result = await execFileAsync("git", ["-C", cwd, ...args], {
    windowsHide: true,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 64 * 1024,
    encoding: "utf8",
    });
    return result.stdout.trim();
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { killed?: boolean; stderr?: string };
    // config --get exits 1 only when the optional origin setting is absent.
    if (args[0] === "config" && String(failure.code) === "1") return "";
    const reason = failure.code === "ENOENT" ? "git_unavailable"
      : failure.killed ? "git_timeout"
      : /dubious ownership/i.test(failure.stderr ?? "") ? "git_ownership"
      : /not a git repository/i.test(failure.stderr ?? "") ? "git_not_repository" : "git_failed";
    throw new ImplementationBindFailure("repository", reason, error);
  }
}

export async function inspectImplementationRepo(cwd: string,
  runGit: (cwd: string, args: readonly string[]) => Promise<string> = git): Promise<ImplementationRepoContext> {
  const requested = cwd.trim();
  if (!requested || !isAbsolute(requested)) throw new ImplementationBindFailure("repository", "invalid_cwd");
  const repoPath = resolve(await runGit(requested, ["rev-parse", "--show-toplevel"]));
  const [branch, repoOrigin] = await Promise.all([
    runGit(repoPath, ["branch", "--show-current"]),
    runGit(repoPath, ["config", "--get", "remote.origin.url"]),
  ]);
  if (!branch) throw new ImplementationBindFailure("repository", "unnamed_branch");
  return { repoPath, repoOrigin: repoOrigin || null, branch };
}
