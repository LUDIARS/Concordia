import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WorktreeGit } from "./worktree-metadata.js";

const execute = promisify(execFile);

export const worktreeGit: WorktreeGit = async (cwd, args) => {
  const result = await execute("git", ["-C", cwd, ...args], {
    windowsHide: true, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024,
  });
  return result.stdout.trim();
};
