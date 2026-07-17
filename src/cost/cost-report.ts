/**
 * コスト / 使用量レポートの「データ収集」と「markdown 描画」を platform 非依存で集約する。
 *
 * Discord の cost チャンネル (discord/cost-channel.ts) と Slack の cost Canvas
 * (slack/cost-canvas.ts) が同じ集計・同じ本文を共有するための単一の正本。
 * タイムスタンプ表現だけは platform で異なる (Discord は `<t:...>` トークン、 Slack は
 * 素のテキスト) ので {@link CostTimestampFormat} で注入する。
 */

import type { SessionsRepo } from "../db/sessions-repo.js";
import type { SessionRow } from "../shared/types.js";
import { fetchClaudeOAuthUsage, type OAuthUsage } from "../auth/anthropic-oauth-usage.js";
import { fetchCodexRateLimits } from "./codex-rate-limits.js";
import type { Totals } from "../cost/log-usage.js";
import { cachedReadSessionUsage, readLatestCodexTokenCountLine } from "./session-usage-cache.js";

/** OAuth usage 取得時の任意ロガー (fetchClaudeOAuthUsage の log と同形)。 */
type UsageLogger = { warn: (msg: string) => void; info?: (msg: string) => void };
type PerfLogger = { warn: (msg: string) => void; info?: (msg: string) => void };

// CostRate は取得側 (codex-rate-limits) と共有するため cost-rate.ts へ分離。
// 既存 import 互換のためここから再エクスポートする。
export type { CostRate } from "./cost-rate.js";
import type { CostRate } from "./cost-rate.js";

/** cost 本文を描くのに必要な集計済みデータ一式。 */
export interface CostReport {
  codexTotals: Totals;
  claudeTotals: Totals;
  codexRate: CostRate;
  claudeUsage: OAuthUsage | null;
}

/** platform 差分 (Discord は `<t:..>` トークン、 Slack は素のテキスト) を吸収する formatter。 */
export interface CostTimestampFormat {
  /** "Updated: ..." の右辺 (相対表現が望ましい)。 */
  updated(nowSec: number): string;
  /** リセット時刻等の絶対(+相対)表現。 null は "-"。 */
  at(epochSec: number | null): string;
}

/**
 * active セッションのログから Codex/Claude のトークン累計と rate-limit を集計し、
 * Claude は claude.ai OAuth usage を取得して返す。 描画前のデータ収集を 1 箇所に集約。
 */
export async function collectCostReport(
  sessionsRepo: SessionsRepo,
  opts?: {
    oauthLog?: UsageLogger;
    perfLog?: PerfLogger;
    allowFullScan?: boolean;
    /** テスト用: codex rate-limit fetcher の差し替え (既定 fetchCodexRateLimits)。 */
    codexRateFetcher?: () => Promise<CostRate | null>;
  },
): Promise<CostReport> {
  const totalStartedAt = Date.now();
  const logStep = (name: string, startedAt: number, extra = ""): void => {
    const duration = Date.now() - startedAt;
    const msg = `cost-report ${name} duration_ms=${duration}${extra}`;
    if (duration >= 1000) opts?.perfLog?.warn(msg);
    else opts?.perfLog?.info?.(msg);
  };
  let startedAt = Date.now();
  const active = sessionsRepo.listSessions({ status: "active" });
  logStep("list-active-sessions", startedAt, ` sessions=${active.length}`);
  await yieldToEventLoop();
  startedAt = Date.now();
  const codex = active.filter((s) => s.provider === "codex-cli");
  const claude = active.filter((s) => s.provider === "claude-code");
  logStep("split-sessions", startedAt, ` codex=${codex.length} claude=${claude.length}`);
  await yieldToEventLoop();
  startedAt = Date.now();
  const allowFullScan = opts?.allowFullScan !== false;
  const codexTotals = await aggregate(codex, allowFullScan);
  logStep("aggregate-codex", startedAt, ` sessions=${codex.length}`);
  await yieldToEventLoop();
  startedAt = Date.now();
  const claudeTotals = await aggregate(claude, allowFullScan);
  logStep("aggregate-claude", startedAt, ` sessions=${claude.length}`);
  await yieldToEventLoop();
  startedAt = Date.now();
  // rate 枠は `codex app-server` の account/rateLimits/read でセッション非依存に取る
  // (2026-07-13〜)。 取得失敗時のみ旧経路 (active セッションの rollout token_count 行)
  // へフォールバックする。
  const fetchRate = opts?.codexRateFetcher ?? (() => fetchCodexRateLimits({ log: opts?.oauthLog }));
  const apiRate = await fetchRate();
  const codexRate = apiRate ?? (await aggregateCodexRate(codex, allowFullScan));
  logStep("codex-rate", startedAt, ` source=${apiRate ? "app-server" : `sessions(${codex.length})`}`);
  await yieldToEventLoop();
  // Claude Code は JSONL に rate-limit を書かないので、 claude.ai OAuth の
  // `/api/oauth/usage` を直接叩いて 5H / 7D / Sonnet / Opus 利用率を取る.
  const claudeUsage = await fetchClaudeOAuthUsage(opts?.oauthLog ? { log: opts.oauthLog } : {});
  logStep("fetch-claude-oauth-usage", startedAt, ` available=${claudeUsage ? 1 : 0}`);
  opts?.perfLog?.info?.(`cost-report total duration_ms=${Date.now() - totalStartedAt}`);
  return { codexTotals, claudeTotals, codexRate, claudeUsage };
}

/**
 * 集計データを「## コスト / 使用量」見出しの markdown 本文に描く。
 * Discord / Slack で本文を共通化し、 タイムスタンプ表現だけ {@link CostTimestampFormat} で変える。
 */
export function renderCostReportMarkdown(
  report: CostReport,
  fmt: CostTimestampFormat,
  nowSec: number,
): string {
  const { codexTotals, claudeTotals, codexRate, claudeUsage } = report;
  const lines: string[] = [];
  lines.push("## コスト / 使用量");
  lines.push(`- Updated: ${fmt.updated(nowSec)}`);
  lines.push("");
  lines.push("### Codex");
  lines.push(`- Tokens: ${fmtNum(codexTotals.total)} (in=${fmtNum(codexTotals.input)}, cached=${fmtNum(codexTotals.cached)}, out=${fmtNum(codexTotals.output)})`);
  lines.push(`- 5H リミット残: ${pct(remain(codexRate.used5h))}`);
  lines.push(`- 週間リミット残: ${pct(remain(codexRate.usedWeekly))}`);
  lines.push(`- 5H リセット: ${fmt.at(codexRate.reset5hAt)}`);
  lines.push(`- 週間リセット: ${fmt.at(codexRate.resetWeeklyAt)}`);
  lines.push("");
  lines.push("### Claude Code");
  lines.push(`- Tokens: ${fmtNum(claudeTotals.total)} (in=${fmtNum(claudeTotals.input)}, cached=${fmtNum(claudeTotals.cached)}, out=${fmtNum(claudeTotals.output)})`);
  if (claudeUsage) {
    lines.push(`- 5H リミット残: ${pct(remain(claudeUsage.fiveHour?.utilization ?? null))}`);
    lines.push(`- 週間リミット残: ${pct(remain(claudeUsage.sevenDay?.utilization ?? null))}`);
    lines.push(`- 5H リセット: ${fmt.at(claudeUsage.fiveHour?.resetsAtSec ?? null)}`);
    lines.push(`- 週間リセット: ${fmt.at(claudeUsage.sevenDay?.resetsAtSec ?? null)}`);
    if (claudeUsage.sevenDaySonnet) {
      lines.push(`- 週間 Sonnet 残: ${pct(remain(claudeUsage.sevenDaySonnet.utilization))} (リセット ${fmt.at(claudeUsage.sevenDaySonnet.resetsAtSec)})`);
    }
    if (claudeUsage.sevenDayOpus) {
      lines.push(`- 週間 Opus 残: ${pct(remain(claudeUsage.sevenDayOpus.utilization))} (リセット ${fmt.at(claudeUsage.sevenDayOpus.resetsAtSec)})`);
    }
    if (claudeUsage.extraCredit.isEnabled && claudeUsage.extraCredit.utilization !== null) {
      lines.push(`- 追加クレジット使用率: ${pct(claudeUsage.extraCredit.utilization)}`);
    }
  } else {
    lines.push("- 5H リミット残: - (OAuth usage 取得失敗)");
    lines.push("- 週間リミット残: -");
    lines.push("- 5H リセット: -");
    lines.push("- 週間リセット: -");
  }
  lines.push("");
  lines.push("_セッション単位の表示は省略。プロバイダ別集計のみ表示。_");
  return lines.join("\n");
}

async function aggregate(sessions: SessionRow[], allowFullScan: boolean): Promise<Totals> {
  const out: Totals = { input: 0, cached: 0, output: 0, total: 0 };
  if (!allowFullScan) return out;
  for (const s of sessions) {
    const t = await cachedReadSessionUsage(s, { allowFullScan });
    if (!t) continue;
    out.input += t.input;
    out.cached += t.cached;
    out.output += t.output;
    out.total += t.total;
  }
  return out;
}

async function aggregateCodexRate(sessions: SessionRow[], allowFullScan: boolean): Promise<CostRate> {
  let minRemain5h: number | null = null;
  let minRemainWeekly: number | null = null;
  let minReset5h: number | null = null;
  let minResetWeekly: number | null = null;
  if (!allowFullScan) {
    return {
      used5h: null,
      usedWeekly: null,
      reset5hAt: null,
      resetWeeklyAt: null,
      plan: null,
    };
  }
  // rate と plan は同じ token_count 行から取れるので、 セッションあたり 1 回だけ読む
  // (旧実装は plan のためだけに readCodexRate をもう一周していた)。
  const rates = await Promise.all(sessions.map((s) => readCodexRate(s, allowFullScan)));
  for (const r of rates) {
    if (!r) continue;
    const r5 = remain(r.used5h);
    const rw = remain(r.usedWeekly);
    if (r5 !== null) minRemain5h = minRemain5h === null ? r5 : Math.min(minRemain5h, r5);
    if (rw !== null) minRemainWeekly = minRemainWeekly === null ? rw : Math.min(minRemainWeekly, rw);
    if (r.reset5hAt !== null) minReset5h = minReset5h === null ? r.reset5hAt : Math.min(minReset5h, r.reset5hAt);
    if (r.resetWeeklyAt !== null) minResetWeekly = minResetWeekly === null ? r.resetWeeklyAt : Math.min(minResetWeekly, r.resetWeeklyAt);
  }
  return {
    used5h: minRemain5h === null ? null : 100 - minRemain5h,
    usedWeekly: minRemainWeekly === null ? null : 100 - minRemainWeekly,
    reset5hAt: minReset5h,
    resetWeeklyAt: minResetWeekly,
    plan: firstString(...rates.map((r) => r?.plan ?? null)),
  };
}

async function readCodexRate(s: SessionRow, allowFullScan: boolean): Promise<CostRate | null> {
  const o = (await readLatestCodexTokenCountLine(s, { allowFullScan })) as any;
  if (!o) return null;
  return {
    used5h: nnull(o?.payload?.rate_limits?.primary?.used_percent),
    usedWeekly: nnull(o?.payload?.rate_limits?.secondary?.used_percent),
    reset5hAt: nnEpoch(o?.payload?.rate_limits?.primary?.resets_at),
    resetWeeklyAt: nnEpoch(o?.payload?.rate_limits?.secondary?.resets_at),
    plan: firstString(
      o?.payload?.plan,
      o?.payload?.rate_limits?.plan,
      o?.payload?.rate_limits?.plan_type,
      o?.payload?.rate_limits?.tier,
      o?.payload?.rate_limits?.subscription,
    ),
  };
}

function firstString(...values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function nnull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function nnEpoch(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
}

export function remain(used: number | null): number | null {
  if (used === null) return null;
  return Math.max(0, Math.min(100, 100 - used));
}

function pct(v: number | null): string {
  return v === null ? "-" : `${v.toFixed(1)}%`;
}

function fmtNum(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
