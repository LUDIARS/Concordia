import { spawn } from "node:child_process";

/** メトリクス補助コマンドの stdout を集める。失敗・非0終了・timeoutは null。 */
export function runCapture(cmd: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { shell: false, windowsHide: true });
    let out = "";
    let settled = false;
    const done = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try { proc.kill("SIGTERM"); } catch { /* already gone */ }
      done(null);
    }, timeoutMs);
    proc.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    proc.on("error", () => done(null));
    proc.on("close", (code) => done(code === 0 ? out : null));
  });
}
