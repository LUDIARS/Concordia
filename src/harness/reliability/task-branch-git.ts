import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

const run = promisify(execFile);
export interface BranchSnapshot { repo: string; branch: string; mainExists: boolean }

/** Read current Git state at the action boundary; never checkout/stash/reset here. */
export async function readBranchSnapshot(cwd: string): Promise<BranchSnapshot> {
  const git = async (args: string[]): Promise<string> => (await run("git", ["-C", cwd, ...args], {
    encoding: "utf8", windowsHide: true, timeout: 3000, maxBuffer: 65536,
  })).stdout.trim();
  const repo = resolve(await git(["rev-parse", "--show-toplevel"]));
  const branch = await git(["branch", "--show-current"]);
  // --list returns empty for a missing local main without hiding execution errors.
  const mainExists = Boolean(await git(["branch", "--list", "main"]));
  return { repo, branch, mainExists };
}
