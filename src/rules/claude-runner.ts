/**
 * claude CLI subprocess wrapper.
 *
 * - prompt は stdin で渡す (LUDIARS memo 準拠: 長 prompt の Windows ENAMETOOLONG 回避)
 * - Windows では CLAUDE_CODE_GIT_BASH_PATH が必要 (memo 準拠)
 * - timeout は CONCORDIA_CLAUDE_TIMEOUT_MS env で上書き可、 default 120 秒
 * - 失敗は warn ログ + null 返し (engine 側で skip 扱い)
 */

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { createChildLogger } from "../shared/logger.js";
import { recordLocalOneShot } from "../cost/one-shot-recorder.js";

const log = createChildLogger("claude-runner");
const TIMEOUT_MS = Number(process.env.CONCORDIA_CLAUDE_TIMEOUT_MS ?? "120000");

/**
 * Windows の git-bash 候補パス解決結果 (プロセス内メモ化)。
 * runClaude は rule engine / report 生成 / delegation / reaction-workflow から
 * 高頻度に呼ばれるリクエスト経路であり、 existsSync を毎回同期実行しないよう
 * fs/promises 化 + 一度解決した結果をキャッシュする (id 538 A-5 残件対応)。
 * undefined = 未解決、 null = 候補どちらも見つからず (以後探索しない)。
 */
let gitBashPathCache: string | null | undefined;

async function resolveGitBashPath(): Promise<string | null> {
  if (gitBashPathCache !== undefined) return gitBashPathCache;
  const candidates = [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  ];
  for (const c of candidates) {
    try {
      await access(c);
      gitBashPathCache = c;
      return gitBashPathCache;
    } catch {
      // try next candidate
    }
  }
  gitBashPathCache = null;
  return gitBashPathCache;
}

/** テスト用: メモ化キャッシュをクリアする。 */
export function resetGitBashPathCache(): void {
  gitBashPathCache = undefined;
}

export interface ClaudeRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exit_code: number | null;
  duration_ms: number;
}

export interface RunClaudeOptions {
  /** `--model` に渡す値 (例 "haiku" / "sonnet" / "claude-opus-4-8")。 未指定で provider 既定。 */
  model?: string;
  /** subprocess の working directory。 未指定で Concordia の cwd。 */
  cwd?: string;
  /**
   * agentic に file 書き込み / tool 実行をさせたい時に立てる。 `-p` は非対話なので
   * 権限プロンプトを出せず、 これが無いと write 系は実行されず stdout 出力だけになる。
   * `--dangerously-skip-permissions` を付与する (ローカル信頼自動化前提)。
   */
  dangerouslySkipPermissions?: boolean;
  /** timeout 上書き (ms)。 未指定で CONCORDIA_CLAUDE_TIMEOUT_MS / 120s。 */
  timeoutMs?: number;
}

export type RunClaudeFn = (
  prompt: string,
  opts: { model?: string; timeoutMs?: number },
) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

/**
 * `claude -p` を 1 ショット起動して stdout を返す。
 *
 * - 引数 1 つ (prompt のみ) の旧シグネチャは互換維持 (rules / report 等)。
 * - opts で `--model` / cwd / 権限スキップ / timeout を上書きできる
 *   (reaction-workflow が agentic 記録に使う)。
 */
export async function runClaude(
  prompt: string,
  opts: RunClaudeOptions = {},
): Promise<ClaudeRunResult> {
  const startedAt = Date.now();
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const env: NodeJS.ProcessEnv = { ...process.env };
  // ホワイトリスト方式 (CONCORDIA_HOOK=1) を採用したので、 spawn 先には
  // CONCORDIA_HOOK を伝播させない. 親 process が CONCORDIA_HOOK=1 でも
  // 子 claude CLI には渡さない. 結果、 子の hook は no-op になり Concordia
  // と無関係に動く.
  delete env.CONCORDIA_HOOK;

  if (process.platform === "win32" && !env.CLAUDE_CODE_GIT_BASH_PATH) {
    const resolved = await resolveGitBashPath();
    if (resolved) env.CLAUDE_CODE_GIT_BASH_PATH = resolved;
  }

  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let timer: NodeJS.Timeout | null = null;
    let resolved = false;

    const args = ["-p"];
    if (opts.model) args.push("--model", opts.model);
    if (opts.dangerouslySkipPermissions) args.push("--dangerously-skip-permissions");

    // Windows は claude が .cmd なので cmd.exe を明示して経由する (famulus-select.ts と
    // 同じ作法)。 shell:true + args 配列は Node が非エスケープ連結する (DEP0190) ため
    // 使わない — args に将来ユーザ由来値が混ざった時の injection 面にもなる。
    const isWin = process.platform === "win32";
    const file = isWin ? env.ComSpec ?? "cmd.exe" : "claude";
    const cliArgs = isWin ? ["/d", "/s", "/c", "claude", ...args] : args;

    let child;
    try {
      child = spawn(file, cliArgs, {
        env,
        cwd: opts.cwd,
        windowsHide: true,
      });
    } catch (e) {
      log.warn({ err: (e as Error).message }, "spawn claude failed");
      recordClaudeOneShot(prompt, opts, {
        startedAt,
        status: "error",
        exit_code: -1,
        duration_ms: Date.now() - startedAt,
        error: (e as Error).message,
      });
      resolve({
        ok: false,
        stdout: "",
        stderr: (e as Error).message,
        exit_code: -1,
        duration_ms: Date.now() - startedAt,
      });
      return;
    }

    child.stdout.on("data", (d) => { out += d.toString("utf8"); });
    child.stderr.on("data", (d) => { err += d.toString("utf8"); });

    child.on("error", (e) => {
      if (resolved) return;
      resolved = true;
      if (timer) clearTimeout(timer);
      log.warn({ err: e.message }, "claude CLI error");
      recordClaudeOneShot(prompt, opts, {
        startedAt,
        status: "error",
        exit_code: -1,
        duration_ms: Date.now() - startedAt,
        error: e.message,
      });
      resolve({
        ok: false,
        stdout: out,
        stderr: e.message,
        exit_code: -1,
        duration_ms: Date.now() - startedAt,
      });
    });

    child.on("close", (code) => {
      if (resolved) return;
      resolved = true;
      if (timer) clearTimeout(timer);
      recordClaudeOneShot(prompt, opts, {
        startedAt,
        status: code === 0 ? "ok" : "error",
        exit_code: code,
        duration_ms: Date.now() - startedAt,
      });
      resolve({
        ok: code === 0,
        stdout: out,
        stderr: err,
        exit_code: code,
        duration_ms: Date.now() - startedAt,
      });
    });

    timer = setTimeout(() => {
      if (resolved) return;
      log.warn({ duration_ms: Date.now() - startedAt }, "claude CLI timeout, killing");
      try { child.kill("SIGKILL"); } catch { /* swallow */ }
      resolved = true;
      recordClaudeOneShot(prompt, opts, {
        startedAt,
        status: "timeout",
        exit_code: -1,
        duration_ms: Date.now() - startedAt,
      });
      resolve({
        ok: false,
        stdout: out,
        stderr: err + "\n[concordia] killed: timeout",
        exit_code: -1,
        duration_ms: Date.now() - startedAt,
      });
    }, timeoutMs);

    try {
      child.stdin.end(prompt);
    } catch (e) {
      log.warn({ err: (e as Error).message }, "claude CLI stdin write failed");
    }
  });
}

function recordClaudeOneShot(
  prompt: string,
  opts: RunClaudeOptions,
  result: {
    startedAt: number;
    status: "ok" | "error" | "timeout";
    exit_code: number | null;
    duration_ms: number;
    error?: string;
  },
): void {
  recordLocalOneShot({
    ts: result.startedAt,
    service: "concordia",
    provider: "claude",
    command: "claude -p",
    model: opts.model ?? null,
    cwd: opts.cwd ?? process.cwd(),
    prompt,
    status: result.status,
    exit_code: result.exit_code,
    duration_ms: result.duration_ms,
    metadata_json: JSON.stringify({
      dangerouslySkipPermissions: opts.dangerouslySkipPermissions === true,
      timeoutMs: opts.timeoutMs,
      error: result.error,
    }),
  });
}

/**
 * AI 出力 (テキスト) から 1 つの JSON object を抽出する.
 * 出力に余計な前置きがある可能性も考慮して、 最初の {…} ブロックを正規表現で拾う.
 */
export function extractJson(text: string): unknown | null {
  const trimmed = text.trim();
  // 直接 JSON
  if (trimmed.startsWith("{")) {
    try { return JSON.parse(trimmed); } catch { /* fall through */ }
  }
  // ``` で囲まれた JSON block
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fence) {
    try { return JSON.parse(fence[1].trim()); } catch { /* fall through */ }
  }
  // 任意の {} ブロック
  const m = /\{[\s\S]*\}/.exec(text);
  if (m) {
    try { return JSON.parse(m[0]); } catch { return null; }
  }
  return null;
}
