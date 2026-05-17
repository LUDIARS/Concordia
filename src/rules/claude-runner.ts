/**
 * claude CLI subprocess wrapper.
 *
 * - prompt は stdin で渡す (LUDIARS memo 準拠: 長 prompt の Windows ENAMETOOLONG 回避)
 * - Windows では CLAUDE_CODE_GIT_BASH_PATH が必要 (memo 準拠)
 * - timeout は CONCORDIA_CLAUDE_TIMEOUT_MS env で上書き可、 default 120 秒
 * - 失敗は warn ログ + null 返し (engine 側で skip 扱い)
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createChildLogger } from "../shared/logger.js";

const log = createChildLogger("claude-runner");
const TIMEOUT_MS = Number(process.env.CONCORDIA_CLAUDE_TIMEOUT_MS ?? "120000");

export interface ClaudeRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exit_code: number | null;
  duration_ms: number;
}

export async function runClaude(prompt: string): Promise<ClaudeRunResult> {
  const startedAt = Date.now();
  const env: NodeJS.ProcessEnv = { ...process.env };
  // ホワイトリスト方式 (CONCORDIA_HOOK=1) を採用したので、 spawn 先には
  // CONCORDIA_HOOK を伝播させない. 親 process が CONCORDIA_HOOK=1 でも
  // 子 claude CLI には渡さない. 結果、 子の hook は no-op になり Concordia
  // と無関係に動く.
  delete env.CONCORDIA_HOOK;

  if (process.platform === "win32" && !env.CLAUDE_CODE_GIT_BASH_PATH) {
    const candidates = [
      "C:\\Program Files\\Git\\bin\\bash.exe",
      "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    ];
    for (const c of candidates) {
      if (existsSync(c)) {
        env.CLAUDE_CODE_GIT_BASH_PATH = c;
        break;
      }
    }
  }

  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let timer: NodeJS.Timeout | null = null;
    let resolved = false;

    let child;
    try {
      child = spawn("claude", ["-p"], {
        env,
        shell: process.platform === "win32",
        windowsHide: true,
      });
    } catch (e) {
      log.warn({ err: (e as Error).message }, "spawn claude failed");
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
      resolve({
        ok: false,
        stdout: out,
        stderr: err + "\n[concordia] killed: timeout",
        exit_code: -1,
        duration_ms: Date.now() - startedAt,
      });
    }, TIMEOUT_MS);

    try {
      child.stdin.end(prompt);
    } catch (e) {
      log.warn({ err: (e as Error).message }, "claude CLI stdin write failed");
    }
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
