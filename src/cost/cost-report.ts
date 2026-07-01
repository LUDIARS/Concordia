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
import { findCodexLog, readLines, readSessionUsage, type Totals } from "../cost/log-usage.js";

/** OAuth usage 取得時の任意ロガー (fetchClaudeOAuthUsage の log と同形)。 */
type UsageLogger = { warn: (msg: string) => void; info?: (msg: string) => void };

/** Codex の rate-limit (used%) とリセット時刻。 Claude は OAuth usage 側で持つ。 */
export interface CostRate {
  used5h: number | null;
  usedWeekly: number | null;
  reset5hAt: number | null;
  resetWeeklyAt: number | null;
  plan: string | null;
}

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
  opts?: { oauthLog?: UsageLogger },
): Promise<CostReport> {
  const active = sessionsRepo.listSessions({ status: "active" });
  const codex = active.filter((s) => s.provider === "codex-cli");
  const claude = active.filter((s) => s.provider === "claude-code");
  const codexTotals = aggregate(codex);
  const claudeTotals = aggregate(claude);
  const codexRate = aggregateCodexRate(codex);
  // Claude Code は JSONL に rate-limit を書かないので、 claude.ai OAuth の
  // `/api/oauth/usage` を直接叩いて 5H / 7D / Sonnet / Opus 利用率を取る.
  const claudeUsage = await fetchClaudeOAuthUsage(opts?.oauthLog ? { log: opts.oauthLog } : {});
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

function aggregate(sessions: SessionRow[]): Totals {
  const out: Totals = { input: 0, cached: 0, output: 0, total: 0 };
  for (const s of sessions) {
    const t = readSessionUsage(s);
    if (!t) continue;
    out.input += t.input;
    out.cached += t.cached;
    out.output += t.output;
    out.total += t.total;
  }
  return out;
}

function aggregateCodexRate(sessions: SessionRow[]): CostRate {
  let minRemain5h: number | null = null;
  let minRemainWeekly: number | null = null;
  let minReset5h: number | null = null;
  let minResetWeekly: number | null = null;
  for (const s of sessions) {
    const r = readCodexRate(s);
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
    plan: firstString(...sessions.map(readCodexPlan)),
  };
}

function readCodexRate(s: SessionRow): CostRate | null {
  const p = findCodexLog(s);
  if (!p) return null;
  let latest: CostRate | null = null;
  for (const line of readLines(p)) {
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    if (o?.type !== "event_msg" || o?.payload?.type !== "token_count") continue;
    latest = {
      used5h: nnull(o?.payload?.rate_limits?.primary?.used_percent),
      usedWeekly: nnull(o?.payload?.rate_limits?.secondary?.used_percent),
      reset5hAt: nnEpoch(o?.payload?.rate_limits?.primary?.resets_at),
      resetWeeklyAt: nnEpoch(o?.payload?.rate_limits?.secondary?.resets_at),
      plan: firstString(
        o?.payload?.plan,
        o?.payload?.rate_limits?.plan,
        o?.payload?.rate_limits?.tier,
        o?.payload?.rate_limits?.subscription,
      ),
    };
  }
  return latest;
}

function readCodexPlan(s: SessionRow): string | null {
  return readCodexRate(s)?.plan ?? null;
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
