import { spawn } from "node:child_process";

export interface RestartChild {
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "spawn", listener: () => void): this;
  unref(): void;
}

export interface RestartTimer {
  unref?: () => void;
}

export interface DetachedBackendRestartOptions {
  cwd: string;
  platform?: NodeJS.Platform;
  exitDelayMs?: number;
  spawnChild?: (command: string, args: string[], options: {
    cwd: string;
    detached: boolean;
    stdio: "ignore";
  }) => RestartChild;
  schedule?: (callback: () => void, delayMs: number) => RestartTimer;
  exit?: (code: number) => void;
  log?: { error: (message: string) => void };
}

/**
 * Starts the replacement backend without letting a spawn failure crash the
 * current backend. The current process exits only after the child emitted
 * `spawn`; ENOENT/EINVAL therefore leave the healthy process serving traffic.
 */
export function startDetachedBackendRestart(opts: DetachedBackendRestartOptions): RestartChild | null {
  const command = (opts.platform ?? process.platform) === "win32" ? "npm.cmd" : "npm";
  const spawnChild = opts.spawnChild ?? ((cmd, args, options) => spawn(cmd, args, options));
  const schedule = opts.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const exit = opts.exit ?? ((code) => process.exit(code));
  let child: RestartChild;
  try {
    child = spawnChild(command, ["run", "dev:backend"], {
      cwd: opts.cwd,
      detached: true,
      stdio: "ignore",
    });
  } catch (error) {
    opts.log?.error(`backend restart spawn threw: ${(error as Error).message}`);
    return null;
  }

  child.once("error", (error) => {
    opts.log?.error(`backend restart spawn failed: ${error.message}`);
  });
  child.once("spawn", () => {
    child.unref();
    const timer = schedule(() => exit(0), opts.exitDelayMs ?? 200);
    timer.unref?.();
  });
  return child;
}
