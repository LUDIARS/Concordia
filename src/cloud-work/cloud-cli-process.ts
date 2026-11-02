import { spawn } from "node:child_process";

export type CloudCliExecute = (executable: string, args: string[], cwd: string, stdin: string) => Promise<string>;

/** Rejects Windows shell wrappers: provider CLIs are always launched as native binaries without a shell. */
export function nativeExecutable(path: string | undefined): path is string {
  return !!path && !/\.(cmd|bat|ps1)$/i.test(path);
}

/**
 * Shell-free provider CLI runner. Secrets travel on stdin, never argv. Diagnostics on stderr are drained
 * without being retained because they can echo request material; failures carry only `failureCode`.
 */
export function createCloudCliExecute(options: { env: NodeJS.ProcessEnv; failureCode: string; timeoutMs?: number }): CloudCliExecute {
  return (executable, args, cwd, stdin) => new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: options.env });
    const chunks: Buffer[] = [];
    let total = 0, failed = false;
    const fail = (): void => { failed = true; child.kill(); };
    const timer = setTimeout(fail, options.timeoutMs ?? 60_000);
    child.stdout.on("data", (chunk: Buffer) => { total += chunk.length; if (total > 65_536) fail(); else chunks.push(chunk); });
    child.stderr.on("data", (chunk: Buffer) => { total += chunk.length; if (total > 65_536) fail(); });
    child.stdin.on("error", fail);
    child.on("error", () => { clearTimeout(timer); reject(new Error(options.failureCode)); });
    child.on("close", code => {
      clearTimeout(timer);
      if (failed || code !== 0) reject(new Error(options.failureCode));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
    child.stdin.end(stdin, "utf8");
  });
}
