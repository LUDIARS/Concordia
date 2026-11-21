import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { BuildJob } from "./models.js";

const run = promisify(execFile);
const gitTimeout = 30_000;
const buildTimeout = 15 * 60_000;
const inherited = new Set(["path", "pathext", "systemroot", "windir", "temp", "tmp", "tmpdir"]);

/** Build runners receive an isolated checkout and explicit inputs, with no Cc credentials in the environment. */
export async function runConfluxBuild(repo: string, runner: string, job: BuildJob, signal: AbortSignal): Promise<void> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => inherited.has(key.toLowerCase())));
  const root = await mkdtemp(join(tmpdir(), "cc-conflux-"));
  const checkout = join(root, "checkout");
  const hooks = join(root, "hooks");
  const git = async (...args: string[]) => (await run("git", ["-c", `core.hooksPath=${hooks}`, ...args], {
    cwd: repo, env, timeout: gitTimeout, windowsHide: true, maxBuffer: 1024 * 1024, encoding: "utf8",
  })).stdout.trim();
  try {
    await mkdir(hooks);
    const sha = await git("rev-parse", "--verify", `${job.commit}^{commit}`);
    const base = `evolution/${job.tide}/${job.variant}`;
    const refs = (await git("for-each-ref", "--format=%(refname)", `refs/heads/${base}`)).split(/\r?\n/);
    const eligible = job.branch ? [`refs/heads/${job.branch}`] : [`refs/heads/${base}`, `refs/heads/${base}/main`];
    const ref = eligible.find((item) => refs.includes(item));
    if (!ref) throw new Error("Conflux mainline is missing");
    await git("merge-base", "--is-ancestor", sha, ref);
    signal.throwIfAborted();
    await git("worktree", "add", "--detach", checkout, sha);
    try {
      await run(process.execPath, [runner, JSON.stringify({ commit: sha, platforms: job.platforms })], {
        cwd: checkout, env, signal, timeout: buildTimeout, windowsHide: true, maxBuffer: 1024 * 1024,
      });
    } finally {
      // The build may generate files, so force applies only to its unique temporary checkout.
      await git("worktree", "remove", "--force", checkout);
    }
  } finally {
    await rmdir(hooks).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    // Keep a failed-to-remove checkout available for diagnosis.
    await rmdir(root).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOTEMPTY") throw error; });
  }
}
