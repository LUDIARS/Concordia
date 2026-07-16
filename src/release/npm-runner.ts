import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface NpmInvocation {
  executable: string;
  args: string[];
}

/** npm の platform 別 execFile 呼び出しを、shell 文字列へ変換せず構築する。 */
export function createNpmInvocation(
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): NpmInvocation {
  if (platform !== "win32") return { executable: "npm", args: [...args] };

  const comSpec = env.ComSpec ?? env.COMSPEC;
  if (!comSpec) throw new Error("ComSpec is not set; cannot launch npm.cmd on Windows");
  return {
    executable: comSpec,
    args: ["/d", "/s", "/c", "npm.cmd", ...args],
  };
}

/** Windows の batch shim も含め、npm を構造化 argv のまま起動する。 */
export async function runNpm(cwd: string, args: readonly string[], timeoutMs: number): Promise<unknown> {
  const invocation = createNpmInvocation(args);
  return execFileAsync(invocation.executable, invocation.args, {
    cwd,
    timeout: timeoutMs,
    windowsHide: true,
  });
}
