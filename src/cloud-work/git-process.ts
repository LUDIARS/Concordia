import { spawn } from "node:child_process";

export type CloudGitCommand = (cwd: string, args: string[], input?: Buffer) => Promise<Buffer>;

/** Binary stdin/stdout, bounded execution, and no inherited Git routing or hooks. */
export function createCloudGitCommand(launch: typeof spawn = spawn): CloudGitCommand {
 return (cwd, args, input) => new Promise((resolve, reject) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
  const child = launch("git", ["-c", "core.hooksPath=/dev/null", "-c", "gc.auto=0", ...args], {
    cwd, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_TERMINAL_PROMPT: "0" },
  });
  const output: Buffer[] = [];
  let size = 0, failed = false;
  const timer = setTimeout(() => { failed = true; child.kill(); }, 60_000);
  child.stdout.on("data", (bytes: Buffer) => {
    size += bytes.length;
    if (size > 1_048_576) { failed = true; child.kill(); }
    else output.push(bytes);
  });
  // Drain diagnostics without leaking repository paths or credentials into errors.
  child.stderr.resume();
  child.stdin.on("error", () => { failed = true; child.kill(); });
  child.once("error", () => { clearTimeout(timer); reject(new Error("cloud_git_process_failed")); });
  child.once("close", code => {
    clearTimeout(timer);
    if (failed || code !== 0) reject(new Error("cloud_git_process_failed"));
    else resolve(Buffer.concat(output));
  });
  child.stdin.end(input);
});
}
export const runCloudGit = createCloudGitCommand();
