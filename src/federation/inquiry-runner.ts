/**
 * 拠点間ワンショット調査の実行 (adapter)。 依頼を受けた側で `claude -p` を 1 回だけ、
 * 読み取り専用の道具で動かす。 同時実行は 1 本、 待ち行列は INQUIRY_QUEUE_LIMIT 本まで。
 *
 * @implements spec/feature/federation-link.md §拠点間ワンショット調査 (SPEC-FED-INQUIRY)
 */
import { execFile, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { spawnOneShot, resolveModel } from "@ludiars/one-shot";
import { windowsTreeKillArgs } from "../processes/runner.js";
import { recordLocalOneShot } from "../cost/one-shot-recorder.js";
import { claudeLaunch } from "../rules/claude-runner.js";
import { buildInquiryPrompt, inquiryClaudeArgs, truncateInquiryOutput } from "./inquiry-policy.js";

export const INQUIRY_QUEUE_LIMIT = 3;
const STDERR_TAIL = 400;

export interface InquiryRunRequest {
  origin: string;
  prompt: string;
  project?: string;
  timeoutSec: number;
}

export interface InquiryRunResult {
  ok: boolean;
  output: string;
  error: string | null;
  durationMs: number;
}

export type InquiryRunner = (request: InquiryRunRequest) => Promise<InquiryRunResult>;

/** 依頼が名指ししたプロジェクトを作業ルート配下から探す。 無指定なら最初のルート。 */
export async function resolveInquiryCwd(roots: readonly string[], project: string | undefined): Promise<string | null> {
  if (!project) return roots[0] ?? null;
  for (const root of roots) {
    const candidate = resolvePath(root, project);
    if (await access(candidate).then(() => true, () => false)) return candidate;
  }
  return null;
}

/** セッション・コーディネータの識別子を子へ渡さない (別セッションを名乗らせない)。 */
export function inquiryEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (/^(CONCORDIA_|LICTOR_|CLAUDECODE$|CLAUDE_CODE_SESSION|CODEX_THREAD_ID$)/.test(key)) delete env[key];
  }
  return env;
}

async function terminate(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    await new Promise<void>((done) => {
      execFile("taskkill.exe", windowsTreeKillArgs(child.pid!), { windowsHide: true }, () => done());
    });
    return;
  }
  try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
}

async function runClaudeOnce(input: { cwd: string; prompt: string; timeoutMs: number }): Promise<{ ok: boolean; output: string; error: string | null }> {
  // npm 版 (claude.cmd のみ) の拠点でも cmd.exe を挟まずに起動する (2026-10-11 MELPOT)。
  const launch = await claudeLaunch();
  return new Promise((done) => {
    let output = "";
    let stderr = "";
    let stopReason: string | null = null;
    let kill: Promise<void> | null = null;
    const child = spawnOneShot(launch.file, [...launch.prefixArgs, ...inquiryClaudeArgs(resolveModel("opus", "claude"))], {
      cwd: input.cwd,
      env: inquiryEnvironment(process.env),
      windowsHide: true,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stop = (reason: string): void => {
      if (kill) return;
      stopReason = reason;
      kill = terminate(child);
    };
    const timer = setTimeout(() => stop(`実行期限 (${Math.round(input.timeoutMs / 1000)} 秒) を超えました`), input.timeoutMs);
    child.stdout!.setEncoding("utf8").on("data", (text: string) => {
      output += text;
      if (output.length > 2 * 64_000) stop("出力が大きすぎるため停止しました");
    });
    child.stderr!.setEncoding("utf8").on("data", (text: string) => { stderr = (stderr + text).slice(-STDERR_TAIL); });
    child.stdin!.on("error", (error) => stop(`標準入力に書けませんでした: ${error.message}`));
    child.on("error", (error) => { stopReason = error.message; });
    child.on("close", (code) => {
      clearTimeout(timer);
      void Promise.resolve(kill).then(() => done({
        ok: code === 0 && !stopReason,
        output,
        error: stopReason ?? (code === 0 ? null : (stderr.trim() || `claude exit ${code}`)),
      }));
    });
    child.stdin!.end(input.prompt, "utf8");
  });
}

export function createInquiryRunner(deps: {
  workspaceRoots(): readonly string[];
  /** テスト差し替え用。 既定は claude -p。 */
  execute?: (input: { cwd: string; prompt: string; timeoutMs: number }) => Promise<{ ok: boolean; output: string; error: string | null }>;
  now?: () => number;
  /** 費用の記録 (Cc の one-shot 台帳)。 テストでは差し替える。 */
  record?: typeof recordLocalOneShot;
}): InquiryRunner {
  const execute = deps.execute ?? runClaudeOnce;
  const now = deps.now ?? Date.now;
  const record = deps.record ?? recordLocalOneShot;
  let running = false;
  const queue: Array<() => void> = [];

  const acquire = async (): Promise<boolean> => {
    if (!running) { running = true; return true; }
    if (queue.length >= INQUIRY_QUEUE_LIMIT) return false;
    await new Promise<void>((wake) => queue.push(wake));
    return true;
  };
  const release = (): void => {
    const next = queue.shift();
    if (next) next(); else running = false;
  };

  return async (request) => {
    const started = now();
    if (!(await acquire())) {
      return { ok: false, output: "", error: "this site is busy with other inquiries; retry later", durationMs: 0 };
    }
    try {
      const cwd = await resolveInquiryCwd(deps.workspaceRoots(), request.project);
      if (!cwd) {
        return {
          ok: false,
          output: "",
          error: request.project ? `project not found under workspace roots: ${request.project}` : "no workspace root is configured",
          durationMs: now() - started,
        };
      }
      const prompt = buildInquiryPrompt({ origin: request.origin, prompt: request.prompt, cwd });
      const result = await execute({ cwd, prompt, timeoutMs: request.timeoutSec * 1000 });
      record({
        ts: started,
        service: "concordia",
        provider: "claude",
        command: "claude -p",
        model: null,
        cwd,
        prompt,
        status: result.ok ? "ok" : "error",
        exit_code: null,
        duration_ms: now() - started,
        metadata_json: JSON.stringify({ kind: "federation-inquiry", origin: request.origin, error: result.error }),
      });
      return {
        ok: result.ok,
        output: truncateInquiryOutput(result.output),
        error: result.error ? result.error.slice(0, 500) : null,
        durationMs: now() - started,
      };
    } catch (error) {
      return { ok: false, output: "", error: String(error).slice(0, 500), durationMs: now() - started };
    } finally {
      release();
    }
  };
}
