import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

export interface CompletionEvidenceRun {
  spawn_cwd?: string | null;
  spawn_worktree_path?: string | null;
  spawn_branch?: string | null;
}

export type CompletionEvidenceVerdict =
  | { ok: true; checked: false }
  | { ok: true; checked: true }
  | { ok: false; reason: string };

const execFileAsync = promisify(execFile);
const GIT_BIN = process.platform === "win32" ? "git.exe" : "git";
const GIT_TIMEOUT_MS = 5_000;
const PROTECTED_BRANCHES = new Set(["main", "develop"]);

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync(GIT_BIN, ["-C", cwd, ...args], {
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

async function countCommitsSinceBase(cwd: string): Promise<number> {
  const counts = await Promise.all(["develop", "main"].map(async (base): Promise<number | null> => {
    try {
      const baseRef = `refs/heads/${base}`;
      const count = await git(cwd, ["rev-list", "--count", "HEAD", `^${baseRef}`]);
      return /^\d+$/.test(count) ? Number(count) : null;
    } catch {
      // Either base may be absent. The other declared base is still valid evidence.
      return null;
    }
  }));
  // A repository may contain both diverged bases. The nearest base is the one
  // that avoids counting unrelated main/develop commits as feature evidence.
  const availableCounts = counts.filter((count): count is number => count !== null);
  return availableCounts.length > 0 ? Math.min(...availableCounts) : 0;
}

/**
 * Verifies a spawned checkout before accepting an agent's self-reported completion.
 * Runs without a checkout are intentionally outside this guard because they cannot
 * be attributed to a branch-owned implementation worktree.
 */
export async function verifyCompletionEvidence(run: CompletionEvidenceRun): Promise<CompletionEvidenceVerdict> {
  const cwd = run.spawn_worktree_path ?? run.spawn_cwd;
  if (!cwd) return { ok: true, checked: false };
  if (!existsSync(cwd) || !existsSync(join(cwd, ".git"))) {
    return { ok: false, reason: "spawned checkout is missing or is not a Git worktree" };
  }
  if (!run.spawn_branch) return { ok: false, reason: "spawned checkout has no recorded feature branch" };

  let branch: string;
  try {
    branch = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  } catch {
    return { ok: false, reason: "spawned checkout Git metadata could not be read" };
  }
  if (branch === "HEAD" || branch !== run.spawn_branch || PROTECTED_BRANCHES.has(branch)) {
    return { ok: false, reason: "spawned checkout is not on its recorded non-protected feature branch" };
  }
  if (await countCommitsSinceBase(cwd) < 1) {
    return { ok: false, reason: "spawned feature branch has no commit beyond main or develop" };
  }
  return { ok: true, checked: true };
}
