import { execFileSync } from "node:child_process";
import type { MigrationRef, MigrationRepository } from "./preflight.js";

type GitRead = (args: readonly string[]) => string;
const commitPattern = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
function commit(value: string): string {
  const sha = value.trim();
  if (!commitPattern.test(sha)) throw new Error("Git did not return one unambiguous commit SHA");
  return sha;
}

/** Bounded, shell-free reads. Disable lazy object fetching in partial clones as well. */
export function gitReader(cwd: string): GitRead {
  return args => {
    try {
      return execFileSync("git", [...args], {
        cwd, encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 8 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
      });
    } catch (error) {
      throw new Error(`Git read ${args[0]} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}

export class GitMigrationRepository implements MigrationRepository {
  constructor(private readonly read: GitRead) {}

  resolve(ref: string): string {
    if (!ref || ref.startsWith("-") || /[\x00-\x20\x7f]/.test(ref)) throw new Error("Invalid migration ref");
    return commit(this.read(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]));
  }

  unmergedBranches(mainSha: string): MigrationRef[] {
    const output = this.read(["for-each-ref", `--no-merged=${commit(mainSha)}`,
      "--format=%(refname)%09%(objectname)", "refs/heads/"]).trim();
    if (!output) return [];
    return output.split(/\r?\n/).map(line => {
      const parts = line.split("\t");
      if (parts.length !== 2 || !parts[0].startsWith("refs/heads/")) throw new Error("Invalid local branch listing");
      return { ref: parts[0], sha: commit(parts[1]) };
    });
  }

  mergeBase(leftSha: string, rightSha: string): string {
    return commit(this.read(["merge-base", "--all", commit(leftSha), commit(rightSha)]));
  }

  schema(sha: string): string {
    return this.read(["show", `${commit(sha)}:src/db/schema.ts`]);
  }
}
