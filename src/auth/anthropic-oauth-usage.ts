/**
 * Claude Code (claude.ai) の OAuth 経由レート使用量を取得する fetcher.
 *
 * Claude Code が OAuth 認証時に保存する `~/.claude/.credentials.json` の
 * accessToken を都度読み出し、 Anthropic 内部 API の
 * `GET https://api.anthropic.com/api/oauth/usage` を叩く.
 *
 * レスポンス例:
 * {
 *   "five_hour": { "utilization": 5.0, "resets_at": "2026-...Z" },
 *   "seven_day": { "utilization": 94.0, "resets_at": "..." },
 *   "seven_day_sonnet": { "utilization": 4.0, "resets_at": "..." },
 *   "seven_day_opus": null,
 *   "extra_usage": { "is_enabled": false, ... },
 *   ...
 * }
 *
 * セキュリティ:
 * - accessToken は **DB / log / 永続化しない**。 fetch ごとにファイルから読む。
 * - エラー (401 / 5xx / file 不在 / network) は null を返して呼び出し側で
 *   プレースホルダ表示にフォールバックさせる.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const FETCH_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 60_000; // 1 分キャッシュ (cost-channel refresh が 10 分間隔なので余裕)

export interface OAuthUsageWindow {
  /** 利用率 0-100 (%). API は実数を返す. */
  utilization: number;
  /** リセット時刻 (UNIX epoch sec). */
  resetsAtSec: number;
}

export interface OAuthUsageExtraCredit {
  isEnabled: boolean;
  monthlyLimit: number | null;
  usedCredits: number | null;
  utilization: number | null;
  currency: string | null;
}

export interface OAuthUsage {
  plan: string | null;
  fiveHour: OAuthUsageWindow | null;
  sevenDay: OAuthUsageWindow | null;
  sevenDaySonnet: OAuthUsageWindow | null;
  sevenDayOpus: OAuthUsageWindow | null;
  extraCredit: OAuthUsageExtraCredit;
  fetchedAt: number;
}

/** 1 分キャッシュ. 起動時 + cost-channel refresh ごとに呼ばれる前提. */
let cache: { value: OAuthUsage | null; at: number } = { value: null, at: 0 };

export async function fetchClaudeOAuthUsage(opts: {
  /** override credentials path. default: ~/.claude/.credentials.json */
  credentialsPath?: string;
  /** force refresh. default false. */
  noCache?: boolean;
  /** logger (optional) */
  log?: { warn: (msg: string) => void; info?: (msg: string) => void };
} = {}): Promise<OAuthUsage | null> {
  const now = Date.now();
  if (!opts.noCache && cache.value && now - cache.at < CACHE_TTL_MS) {
    return cache.value;
  }

  const path = opts.credentialsPath ?? join(homedir(), ".claude", ".credentials.json");
  let token: string;
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    const access = parsed?.claudeAiOauth?.accessToken;
    if (typeof access !== "string" || !access.trim()) {
      opts.log?.warn?.("anthropic-oauth-usage: accessToken missing in credentials");
      return null;
    }
    token = access;
  } catch (e) {
    opts.log?.warn?.(`anthropic-oauth-usage: read credentials failed: ${(e as Error).message}`);
    return null;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(USAGE_ENDPOINT, {
      method: "GET",
      headers: {
        "authorization": `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      opts.log?.warn?.(`anthropic-oauth-usage: HTTP ${res.status} from ${USAGE_ENDPOINT}`);
      return null;
    }
    const json = await res.json();
    const usage = parseUsage(json);
    cache = { value: usage, at: now };
    return usage;
  } catch (e) {
    opts.log?.warn?.(`anthropic-oauth-usage: fetch failed: ${(e as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function parseUsage(raw: unknown): OAuthUsage {
  const r = (raw ?? {}) as Record<string, unknown>;
  const extra = (r.extra_usage ?? {}) as Record<string, unknown>;
  return {
    plan: firstString(
      r.plan,
      r.tier,
      r.subscription,
      (r.subscription as Record<string, unknown> | undefined)?.plan,
      (r.account as Record<string, unknown> | undefined)?.plan,
      (r.organization as Record<string, unknown> | undefined)?.plan,
    ),
    fiveHour: parseWindow(r.five_hour),
    sevenDay: parseWindow(r.seven_day),
    sevenDaySonnet: parseWindow(r.seven_day_sonnet),
    sevenDayOpus: parseWindow(r.seven_day_opus),
    extraCredit: {
      isEnabled: extra.is_enabled === true,
      monthlyLimit: typeof extra.monthly_limit === "number" ? extra.monthly_limit : null,
      usedCredits: typeof extra.used_credits === "number" ? extra.used_credits : null,
      utilization: typeof extra.utilization === "number" ? extra.utilization : null,
      currency: typeof extra.currency === "string" ? extra.currency : null,
    },
    fetchedAt: Date.now(),
  };
}

function firstString(...values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function parseWindow(v: unknown): OAuthUsageWindow | null {
  if (!v || typeof v !== "object") return null;
  const w = v as Record<string, unknown>;
  const u = w.utilization;
  const r = w.resets_at;
  if (typeof u !== "number" || typeof r !== "string") return null;
  const sec = Math.floor(new Date(r).getTime() / 1000);
  if (!Number.isFinite(sec) || sec <= 0) return null;
  return { utilization: u, resetsAtSec: sec };
}

/** テスト用. キャッシュをクリアする. */
export function __resetUsageCacheForTest(): void {
  cache = { value: null, at: 0 };
}
