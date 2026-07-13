/**
 * Codex の rate-limit 枠を `codex app-server` の `account/rateLimits/read` で
 * セッション非依存に取得する。
 *
 * 旧経路 (active セッションの rollout token_count 行から拾う) は「生きている
 * codex セッションが 1 つも無いと取れない」構造だったため、 短命の app-server
 * プロセスを起動して直接読む方式に置き換える (2026-07-13 指示)。 呼び出し元
 * (cost-report) は取得失敗時に旧経路へフォールバックするので、 このモジュールは
 * 失敗を null で返す best-effort でよい。
 *
 * 実測レスポンス (codex 0.144.1):
 *   {"rateLimits":{"primary":{"usedPercent":8,"windowDurationMins":10080,
 *     "resetsAt":1784497715},"secondary":null,"planType":"pro",...}}
 * 窓の意味は position (primary/secondary) ではなく windowDurationMins で判定する
 * (アカウントにより 5h 窓が無く weekly が primary に来る)。
 */

import { spawn } from "node:child_process";
import type { CostRate } from "./cost-rate.js";

const DEFAULT_TIMEOUT_MS = 15_000;
/** 10 分毎の cost 更新 × 複数 platform (Discord/Slack/API) で spawn が重複しないよう TTL キャッシュ。 */
const CACHE_TTL_MS = 4 * 60_000;
/** windowDurationMins がこの値以下なら「5H 枠」、超えるなら「週間枠」とみなす。 */
const FIVE_HOUR_MAX_MINS = 12 * 60;

interface RateWindow {
  usedPercent: number | null;
  resetsAtSec: number | null;
  windowMins: number | null;
}

let cache: { at: number; value: CostRate | null } | null = null;

/** テスト用: TTL キャッシュを破棄する。 */
export function clearCodexRateLimitsCache(): void {
  cache = null;
}

/**
 * `account/rateLimits/read` のレスポンス (result) を CostRate へ写像する (pure)。
 * 窓は windowDurationMins で 5H / 週間 に振り分ける。 どちらでもない中間長は
 * 近い方 (12h 以下 → 5H) に寄せる。 読めない形なら null。
 */
export function mapRateLimitsToCostRate(result: unknown): CostRate | null {
  if (typeof result !== "object" || result === null) return null;
  const rl = (result as Record<string, unknown>).rateLimits;
  if (typeof rl !== "object" || rl === null) return null;
  const r = rl as Record<string, unknown>;
  const windows = [readWindow(r.primary), readWindow(r.secondary)].filter(
    (w): w is RateWindow => w !== null,
  );
  if (windows.length === 0) return null;
  let fiveHour: RateWindow | null = null;
  let weekly: RateWindow | null = null;
  for (const w of windows) {
    if (w.windowMins !== null && w.windowMins > FIVE_HOUR_MAX_MINS) {
      weekly = weekly ?? w;
    } else {
      fiveHour = fiveHour ?? w;
    }
  }
  return {
    used5h: fiveHour?.usedPercent ?? null,
    usedWeekly: weekly?.usedPercent ?? null,
    reset5hAt: fiveHour?.resetsAtSec ?? null,
    resetWeeklyAt: weekly?.resetsAtSec ?? null,
    plan: typeof r.planType === "string" && r.planType.trim() ? r.planType.trim() : null,
  };
}

function readWindow(v: unknown): RateWindow | null {
  if (typeof v !== "object" || v === null) return null;
  const w = v as Record<string, unknown>;
  const used = typeof w.usedPercent === "number" && Number.isFinite(w.usedPercent) ? w.usedPercent : null;
  const resets = typeof w.resetsAt === "number" && Number.isFinite(w.resetsAt) && w.resetsAt > 0
    ? Math.floor(w.resetsAt)
    : null;
  const mins = typeof w.windowDurationMins === "number" && Number.isFinite(w.windowDurationMins)
    ? w.windowDurationMins
    : null;
  if (used === null && resets === null) return null;
  return { usedPercent: used, resetsAtSec: resets, windowMins: mins };
}

export interface FetchCodexRateLimitsOptions {
  timeoutMs?: number;
  binary?: string;
  log?: { warn: (m: string) => void; info?: (m: string) => void };
  /** テスト用 spawn 差し替え。 */
  spawnFn?: typeof spawn;
  /** TTL キャッシュを無視して必ず取得する (テスト / 手動更新用)。 */
  force?: boolean;
}

/**
 * 短命 `codex app-server` を起動して rate-limit 枠を読む。 失敗は null (best-effort)。
 * 結果は {@link CACHE_TTL_MS} キャッシュされ、 cost 描画の多重呼び出しで
 * プロセスを起動し直さない。
 */
export async function fetchCodexRateLimits(
  opts: FetchCodexRateLimitsOptions = {},
): Promise<CostRate | null> {
  if (!opts.force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;
  const value = await fetchOnce(opts).catch((e) => {
    opts.log?.warn(`codex rate-limits fetch failed: ${(e as Error).message}`);
    return null;
  });
  cache = { at: Date.now(), value };
  return value;
}

function fetchOnce(opts: FetchCodexRateLimitsOptions): Promise<CostRate | null> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const binary = opts.binary ?? "codex";
  const spawnFn = opts.spawnFn ?? spawn;
  // Windows では .cmd shim を解決するため cmd.exe 経由で起動する (POSIX は直接)。
  const isWindows = process.platform === "win32";
  const args = ["app-server", "--listen", "stdio://"];
  const child = isWindows
    ? spawnFn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", binary, ...args], { stdio: ["pipe", "pipe", "ignore"] })
    : spawnFn(binary, args, { stdio: ["pipe", "pipe", "ignore"] });

  return new Promise<CostRate | null>((resolve) => {
    let buf = "";
    let done = false;
    const finish = (value: CostRate | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already dead; best-effort */ }
      resolve(value);
    };
    const timer = setTimeout(() => {
      opts.log?.warn(`codex rate-limits fetch timed out after ${timeoutMs}ms`);
      finish(null);
    }, timeoutMs);
    timer.unref?.();

    child.on("error", (e) => {
      opts.log?.warn(`codex app-server spawn failed: ${e.message}`);
      finish(null);
    });
    child.on("exit", () => finish(null));

    child.stdout?.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let msg: unknown;
        try { msg = JSON.parse(line); } catch { continue; }
        if (typeof msg !== "object" || msg === null) continue;
        const m = msg as Record<string, unknown>;
        if (m.id === 1) {
          // initialize 完了 → initialized 通知 + 本命リクエスト。
          write({ jsonrpc: "2.0", method: "initialized", params: {} });
          write({ jsonrpc: "2.0", id: 2, method: "account/rateLimits/read", params: {} });
        } else if (m.id === 2) {
          if ("result" in m) {
            finish(mapRateLimitsToCostRate(m.result));
          } else {
            opts.log?.warn(`codex rate-limits read returned error: ${JSON.stringify(m.error ?? null).slice(0, 200)}`);
            finish(null);
          }
        }
      }
    });

    const write = (o: unknown): void => {
      try { child.stdin?.write(JSON.stringify(o) + "\n"); } catch { finish(null); }
    };
    write({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "concordia-cost", title: "Concordia cost", version: "0.1.0" } },
    });
  });
}
