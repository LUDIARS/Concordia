/**
 * Antigravity CLI の `/usage` を短命プロセスで読み、Gemini の利用枠を取る (best-effort)。
 *
 * `codex-rate-limits.ts` と同じ方針: 4 分の TTL キャッシュ、同時取得の single-flight、
 * 一時的な失敗 (タイムアウト・起動失敗) では 30 分以内の直近の成功値を返す。
 * API キー接続 (アカウントの枠が無い) は agy が exit 2 で知らせるので、直近値で埋めない。
 *
 * 起動は shell を通さず実行ファイルを直接起動する (Git Bash の MSYS は `/usage` をパスに
 * 書き換えるため)。cwd は一時ディレクトリにして、作業場所の trust やプロジェクトに触れない。
 *
 * @implements spec/feature/cost-observability.md Gemini（Antigravity CLI） C-5
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgyUsageOutput, type AgyUsage } from "./agy-usage.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const CACHE_TTL_MS = 4 * 60_000;
const STALE_FALLBACK_MS = 30 * 60_000;
/** agy が「アカウントの枠が無い (API キー接続)」を知らせる終了コード。 */
const NO_ACCOUNT_QUOTA_EXIT = 2;
const MAX_STDOUT_BYTES = 64 * 1024;

export interface FetchAgyUsageOptions {
  timeoutMs?: number;
  /** 実行ファイル。既定は {@link resolveAgyBinary}。 */
  binary?: string;
  log?: { warn: (m: string) => void; info?: (m: string) => void };
  /** テスト用 spawn 差し替え。 */
  spawnFn?: typeof spawn;
  /** TTL キャッシュを無視して必ず取得する (テスト / 手動更新用)。 */
  force?: boolean;
  now?: () => number;
}

interface FetchAttempt {
  value: AgyUsage | null;
  allowStale: boolean;
}

let cache: { at: number; value: AgyUsage | null } | null = null;
let lastGood: { at: number; value: AgyUsage } | null = null;
let inFlight: Promise<AgyUsage | null> | null = null;

/** テスト用: キャッシュを破棄する。 */
export function clearAgyUsageCache(): void {
  cache = null;
  lastGood = null;
  inFlight = null;
}

/**
 * Lictor と同じ順で agy を探す: `LICTOR_AGY_BIN` > インストーラ既定の
 * `%LOCALAPPDATA%/agy/bin/agy.exe` (既存プロセスの PATH に無いことがある) > PATH 上の `agy`。
 */
export function resolveAgyBinary(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): string {
  const override = env.LICTOR_AGY_BIN?.trim();
  if (override) return override;
  const localAppData = env.LOCALAPPDATA?.trim();
  if (localAppData) {
    const installed = join(localAppData, "agy", "bin", "agy.exe");
    if (exists(installed)) return installed;
  }
  return "agy";
}

export async function fetchAgyUsage(opts: FetchAgyUsageOptions = {}): Promise<AgyUsage | null> {
  const now = opts.now ?? Date.now;
  if (!opts.force && cache && now() - cache.at < CACHE_TTL_MS) return cache.value;
  if (!opts.force && inFlight) return inFlight;
  const run = fetchOnce(opts, now).catch((error) => {
    const kind = error instanceof Error ? ((error as NodeJS.ErrnoException).code ?? error.name) : "unknown";
    opts.log?.warn(`agy usage fetch failed (${kind})`);
    return { value: null, allowStale: true } satisfies FetchAttempt;
  }).then((attempt) => {
    const finishedAt = now();
    let value = attempt.value;
    if (value) {
      lastGood = { at: finishedAt, value };
    } else if (attempt.allowStale && lastGood && finishedAt - lastGood.at < STALE_FALLBACK_MS) {
      opts.log?.warn(`agy usage fetch failed; serving last good value from ${Math.round((finishedAt - lastGood.at) / 1000)}s ago`);
      value = lastGood.value;
    }
    cache = { at: finishedAt, value };
    return value;
  }).finally(() => {
    if (inFlight === run) inFlight = null;
  });
  if (!opts.force) inFlight = run;
  return run;
}

function fetchOnce(opts: FetchAgyUsageOptions, now: () => number): Promise<FetchAttempt> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const spawnFn = opts.spawnFn ?? spawn;
  const child = spawnFn(opts.binary ?? resolveAgyBinary(), ["-p", "/usage"], {
    cwd: tmpdir(),
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  return new Promise<FetchAttempt>((resolve) => {
    let stdout = "";
    let done = false;
    const finish = (attempt: FetchAttempt): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already exited */ }
      resolve(attempt);
    };
    const timer = setTimeout(() => {
      opts.log?.warn(`agy usage fetch timed out after ${timeoutMs}ms`);
      finish({ value: null, allowStale: true });
    }, timeoutMs);
    timer.unref?.();
    child.on("error", (error) => {
      opts.log?.warn(`agy usage spawn failed (${(error as NodeJS.ErrnoException).code ?? error.name})`);
      finish({ value: null, allowStale: true });
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_STDOUT_BYTES) stdout += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      if (code === NO_ACCOUNT_QUOTA_EXIT) {
        opts.log?.info?.("agy usage: no account quota (API key connection)");
        finish({ value: null, allowStale: false });
        return;
      }
      if (code !== 0) {
        opts.log?.warn(`agy usage exited with code ${String(code)}`);
        finish({ value: null, allowStale: true });
        return;
      }
      const value = parseAgyUsageOutput(stdout, now());
      // 出力は読めたが枠が 1 行も無い = 形式が変わった。直近値で隠さない。
      if (!value) opts.log?.warn("agy usage output had no quota rows");
      finish({ value, allowStale: false });
    });
  });
}
