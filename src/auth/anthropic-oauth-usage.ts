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
/**
 * 単体では 300ms 程度で返る API だが、Concordia 本体のイベントループが詰まっている間
 * (子会社 Bot 分の cost-report が同時に走り codex app-server を並列 spawn する等) は
 * AbortController のタイマーが遅れて発火し 5 秒では落ちる (2026-09-03: 本社+子会社 3 の
 * 同時 refresh で 24 回中 9 回 null)。 codex 側 (15 秒) と揃える。
 */
const FETCH_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 60_000; // 1 分キャッシュ (cost-channel refresh が 10 分間隔なので余裕)
/** 取得失敗時に直近の成功値を返してよい上限。 これを超えたら正直に null (取れていない) を返す。 */
const STALE_FALLBACK_MS = 30 * 60_000;

export interface OAuthUsageWindow {
  /** 利用率 0-100 (%). API は実数を返す. */
  utilization: number;
  /** リセット時刻 (UNIX epoch sec)。 API が null を返すことがある。 */
  resetsAtSec: number | null;
}

export interface OAuthScopedWindow {
  label: string;
  /** 利用率 0-100 (%). */
  utilization: number;
  /** リセット時刻 (UNIX epoch sec)。 API が null を返すことがある。 */
  resetsAtSec: number | null;
  /** API の severity (normal / warning / critical 等)。 表示用。 */
  severity: string | null;
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
  /**
   * Fable (Mythos 級) 単独の週間窓。 実 API (2026-09-03 実測) では `limits[]` の
   * `kind: "weekly_scoped"` + `scope.model.display_name: "Fable"` として返る (percent 90 等)。
   * 旧想定の `seven_day_fable` 系キーも念のため見る。 無ければ null = 「Fable 使用量は取れない」。
   * forum spawn のモデルサジェストが Fable 可否の判定に使う。
   */
  sevenDayFable: OAuthUsageWindow | null;
  /**
   * `limits[]` のモデル/面スコープ付き週間枠すべて (Fable 以外が増えても表示できるように)。
   * label は API の display_name (無ければ model id / surface)。
   */
  weeklyScoped: OAuthScopedWindow[];
  extraCredit: OAuthUsageExtraCredit;
  fetchedAt: number;
}

/** 1 分キャッシュ. 起動時 + cost-channel refresh ごとに呼ばれる前提. */
let cache: { value: OAuthUsage | null; at: number } = { value: null, at: 0 };
/** 直近に取得できた値 (失敗時のフォールバック用。 cache と違い TTL 切れでも保持)。 */
let lastGood: OAuthUsage | null = null;
/**
 * 進行中の取得。 本社 + 子会社 Bot の cost refresh は同じ秒に並ぶため、キャッシュ切れの
 * 瞬間に同じ取得が Bot 数ぶん並走する。 1 本に束ねて残りは同じ結果を待つ (single-flight)。
 */
let inFlight: Promise<OAuthUsage | null> | null = null;

export interface FetchClaudeOAuthUsageOptions {
  /** override credentials path. default: ~/.claude/.credentials.json */
  credentialsPath?: string;
  /** force refresh. default false. */
  noCache?: boolean;
  /** logger (optional) */
  log?: { warn: (msg: string) => void; info?: (msg: string) => void };
}

interface FreshUsageResult {
  usage: OAuthUsage | null;
  /** Network/service failures may use a recent value; credential/auth failures must not. */
  allowStale: boolean;
}

export async function fetchClaudeOAuthUsage(opts: FetchClaudeOAuthUsageOptions = {}): Promise<OAuthUsage | null> {
  const now = Date.now();
  if (!opts.noCache && cache.at !== 0 && now - cache.at < CACHE_TTL_MS) {
    return cache.value;
  }
  if (!opts.noCache && inFlight) return inFlight;

  const run = fetchFreshUsage(opts).then(({ usage, allowStale }) => {
    const finishedAt = Date.now();
    if (usage) {
      cache = { value: usage, at: finishedAt };
      lastGood = usage;
      return usage;
    }
    // 一時的な失敗 (タイムアウト / 5xx / イベントループ詰まり) で cost 面が「取れない」に
    // 落ちないよう、直近成功値が新しければそれを返す。 fetchedAt は古いままなので
    // 呼び出し側は鮮度を判別できる。 次の試行はキャッシュ TTL 後 (連打しない)。
    if (allowStale && lastGood && finishedAt - lastGood.fetchedAt < STALE_FALLBACK_MS) {
      opts.log?.warn?.(
        `anthropic-oauth-usage: fetch failed; serving last good value from ${Math.round((finishedAt - lastGood.fetchedAt) / 1000)}s ago`,
      );
      cache = { value: lastGood, at: finishedAt };
      return lastGood;
    }
    cache = { value: null, at: finishedAt };
    return null;
  }).finally(() => {
    if (inFlight === run) inFlight = null;
  });
  if (!opts.noCache) inFlight = run;
  return run;
}

/** キャッシュを見ずに 1 回取得する。 失敗は null (理由は log)。 */
async function fetchFreshUsage(opts: FetchClaudeOAuthUsageOptions): Promise<FreshUsageResult> {
  const path = opts.credentialsPath ?? join(homedir(), ".claude", ".credentials.json");
  let token: string;
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    const access = parsed?.claudeAiOauth?.accessToken;
    if (typeof access !== "string" || !access.trim()) {
      opts.log?.warn?.("anthropic-oauth-usage: accessToken missing in credentials");
      return { usage: null, allowStale: false };
    }
    token = access;
  } catch (e) {
    const errorKind = e instanceof Error ? ((e as NodeJS.ErrnoException).code ?? e.name) : "unknown";
    // fs error messages contain the credentials path (and often the local username); do not persist them.
    opts.log?.warn?.(`anthropic-oauth-usage: read credentials failed (${errorKind})`);
    return { usage: null, allowStale: false };
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
      opts.log?.warn?.(`anthropic-oauth-usage: HTTP ${res.status}`);
      const allowStale = res.status === 408 || res.status === 429 || res.status >= 500;
      return { usage: null, allowStale };
    }
    const json = await res.json();
    return { usage: parseUsage(json), allowStale: false };
  } catch (e) {
    const errorKind = e instanceof Error ? e.name : "unknown";
    opts.log?.warn?.(`anthropic-oauth-usage: fetch failed (${errorKind})`);
    return { usage: null, allowStale: true };
  } finally {
    clearTimeout(timer);
  }
}

function parseUsage(raw: unknown): OAuthUsage {
  const r = (raw ?? {}) as Record<string, unknown>;
  const extra = (r.extra_usage ?? {}) as Record<string, unknown>;
  const weeklyScoped = parseScopedLimits(r.limits);
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
    sevenDayFable: parseFableWindow(r, weeklyScoped),
    weeklyScoped,
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

const FABLE_SCOPE_PATTERN = /fable|mythos/i;

/**
 * Fable 級の週間窓。 一次ソースは `limits[]` の weekly_scoped (scope.model が Fable)。
 * 旧想定の `seven_day_fable` / `seven_day_mythos` キーも後方互換で見る。
 */
function parseFableWindow(
  r: Record<string, unknown>,
  weeklyScoped: readonly OAuthScopedWindow[],
): OAuthUsageWindow | null {
  const scoped = weeklyScoped.find((limit) => FABLE_SCOPE_PATTERN.test(limit.label));
  if (scoped) {
    return { utilization: scoped.utilization, resetsAtSec: scoped.resetsAtSec };
  }
  for (const key of Object.keys(r)) {
    if (/^seven_day_(fable|mythos)/.test(key)) {
      const window = parseWindow(r[key]);
      if (window) return window;
    }
  }
  return null;
}

/**
 * `limits[]` からモデル/面スコープ付きの週間枠を取り出す。 実測の形:
 * `{kind:"weekly_scoped",group:"weekly",percent:90,severity:"critical",resets_at:"...",
 *   scope:{model:{id:null,display_name:"Fable"},surface:null}}`。
 * weekly_all / session (全体枠) は five_hour / seven_day と重複するので含めない。
 */
function parseScopedLimits(v: unknown): OAuthScopedWindow[] {
  if (!Array.isArray(v)) return [];
  const out: OAuthScopedWindow[] = [];
  for (const item of v) {
    if (!item || typeof item !== "object") continue;
    const limit = item as Record<string, unknown>;
    if (limit.kind !== "weekly_scoped") continue;
    const percent = limit.percent;
    if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100) continue;
    const scope = (limit.scope ?? {}) as Record<string, unknown>;
    const model = (scope.model ?? null) as Record<string, unknown> | null;
    const label = normalizeScopedLabel(firstString(model?.display_name, model?.id, scope.surface));
    if (!label) continue;
    const resets = typeof limit.resets_at === "string" ? Math.floor(new Date(limit.resets_at).getTime() / 1000) : NaN;
    out.push({
      label,
      utilization: percent,
      resetsAtSec: Number.isFinite(resets) && resets > 0 ? resets : null,
      severity: parseSeverity(limit.severity),
    });
  }
  return out;
}

/** 外部 API の表示名を単一行に制限し、Discord / Slack の mention 記法を持ち込ませない。 */
function normalizeScopedLabel(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.replace(/[\u0000-\u001f\u007f@<>&]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return normalized || null;
}

function parseSeverity(value: unknown): string | null {
  return typeof value === "string" && /^[a-z][a-z0-9_-]{0,31}$/i.test(value) ? value : null;
}

/** テスト用. キャッシュをクリアする. */
export function __resetUsageCacheForTest(): void {
  cache = { value: null, at: 0 };
  lastGood = null;
  inFlight = null;
}
