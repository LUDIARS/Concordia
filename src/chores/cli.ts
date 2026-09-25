import { spawn, execFile, type ChildProcess } from "node:child_process";
import { readFile, mkdir, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { CHORE_OUTPUT_BYTES, CHORE_TIMEOUT_MS, type Chore } from "./domain.js";

export function choreCommand(provider: Chore["provider"], outputPath: string, platform: NodeJS.Platform): { file: string; args: string[] } {
  const file = platform === "win32" ? `${provider}.exe` : provider;
  return { file, args: provider === "claude" ? ["-p"] : ["exec", "--skip-git-repo-check", "--output-last-message", outputPath, "-"] };
}
export function choreEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...source };
  // A standalone invocation must not impersonate its parent coordinator/session.
  for (const key of Object.keys(env)) {
    if (/^(CONCORDIA_|LICTOR_|CLAUDECODE$|CLAUDE_CODE_SESSION|CODEX_THREAD_ID$)/.test(key)) delete env[key];
  }
  return env;
}
async function terminate(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve, reject) => {
      execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, (error) => {
        if (error && child.exitCode === null) reject(error); else resolve();
      });
    });
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}

export async function executeChoreCli(run: Chore, signal: AbortSignal): Promise<{ ok: boolean; output: string; error: string | null }> {
  await mkdir(run.cwd, { recursive: true });
  await writeFile(join(run.cwd, "request.txt"), run.prompt, "utf8");
  if (signal.aborted) return { ok: false, output: "", error: "実行開始前に停止しました。" };
  const outputPath = join(run.cwd, "last-message.txt");
  const command = choreCommand(run.provider, outputPath, process.platform);
  const result = await new Promise<{ ok: boolean; output: string; error: string | null }>((resolve) => {
    let output = "";
    let errors = "";
    let bytes = 0;
    let stopReason: string | null = null;
    let kill: Promise<void> | null = null;
    const child = spawn(command.file, command.args, { cwd: run.cwd, env: choreEnvironment(process.env),
      windowsHide: true, shell: false, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    const stop = (reason: string): void => {
      if (kill) return;
      stopReason = reason;
      kill = terminate(child).catch((error: unknown) => {
        // Keep waiting for close: never release an execution slot with a live child.
        stopReason = `${reason}; 子プロセス停止失敗: ${String(error)}`;
      });
    };
    const abort = (): void => stop("実行を停止しました。");
    const timer = setTimeout(() => stop("実行期限（10分）を超過しました。"), CHORE_TIMEOUT_MS);
    signal.addEventListener("abort", abort, { once: true });
    const collect = (text: string, stderr: boolean): void => {
      bytes += Buffer.byteLength(text, "utf8");
      if (bytes > CHORE_OUTPUT_BYTES) { stop("出力上限を超過しました。"); return; }
      if (stderr) errors += text; else output += text;
    };
    child.stdout.setEncoding("utf8").on("data", (text: string) => collect(text, false));
    child.stderr.setEncoding("utf8").on("data", (text: string) => collect(text, true));
    child.stdin.on("error", (error) => stop(`標準入力失敗: ${error.message}`));
    child.on("error", (error) => { stopReason = error.message; });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      // Tree termination must finish before the application releases its slot.
      void Promise.resolve(kill).then(() => resolve({ ok: code === 0 && !stopReason, output,
        error: stopReason ?? (code === 0 ? null : errors || `CLI exit ${code}`) }));
    });
    if (signal.aborted) abort();
    child.stdin.end(run.prompt, "utf8");
  });
  if (run.provider === "codex" && result.ok) {
    if ((await stat(outputPath)).size > CHORE_OUTPUT_BYTES) return { ok: false, output: result.output, error: "結果の出力上限を超過しました。" };
    const text = await readFile(outputPath, "utf8");
    if (Buffer.byteLength(text, "utf8") > CHORE_OUTPUT_BYTES) return { ok: false, output: "", error: "結果の出力上限を超過しました。" };
    result.output = text;
  }
  try { await writeFile(join(run.cwd, "result.txt"), result.output + (result.error ? `\n\n${result.error}` : ""), "utf8"); }
  catch (error) { return { ok: false, output: result.output, error: `結果ファイルの保存に失敗しました: ${String(error)}` }; }
  return result;
}
