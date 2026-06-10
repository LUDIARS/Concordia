import type { TextChannel } from "discord.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { SessionRow } from "../shared/types.js";
import { fetchClaudeOAuthUsage, type OAuthUsage } from "../auth/anthropic-oauth-usage.js";
import { createChildLogger } from "../shared/logger.js";
// トークン集計のログ読み取りは cost/log-usage に集約 (cost budget と共用)。
import { findCodexLog, readLines, readSessionUsage, type Totals } from "../cost/log-usage.js";

const oauthUsageLog = createChildLogger("cost-channel.oauth-usage");

const COST_MESSAGE_KEY = "cost_status_message_id";

type Rate = {
  used5h: number | null;
  usedWeekly: number | null;
  reset5hAt: number | null;
  resetWeeklyAt: number | null;
};

export async function upsertCostChannelMessage(
  channel: TextChannel,
  sessionsRepo: SessionsRepo,
  configGet: (k: string) => string | null,
  configSet: (k: string, v: string) => void,
  activityChannel?: TextChannel | null,
): Promise<void> {
  const active = sessionsRepo.listSessions({ status: "active" });
  const codex = active.filter((s) => s.provider === "codex-cli");
  const claude = active.filter((s) => s.provider === "claude-code");

  const codexTotals = aggregate(codex);
  const claudeTotals = aggregate(claude);
  const codexRate = aggregateCodexRate(codex);
  // Claude Code は JSONL に rate-limit を書かないので、 claude.ai OAuth の
  // `/api/oauth/usage` を直接叩いて 5H / 7D / Sonnet / Opus 利用率を取る.
  const claudeUsage = await fetchClaudeOAuthUsage({ log: oauthUsageLog });

  const lines: string[] = [];
  lines.push("## コスト / 使用量");
  lines.push(`- Updated: <t:${Math.floor(Date.now() / 1000)}:R>`);
  lines.push("");
  lines.push("### Codex");
  lines.push(`- Tokens: ${fmt(codexTotals.total)} (in=${fmt(codexTotals.input)}, cached=${fmt(codexTotals.cached)}, out=${fmt(codexTotals.output)})`);
  lines.push(`- 5H リミット残: ${pct(remain(codexRate.used5h))}`);
  lines.push(`- 週間リミット残: ${pct(remain(codexRate.usedWeekly))}`);
  lines.push(`- 5H リセット: ${ts(codexRate.reset5hAt)}`);
  lines.push(`- 週間リセット: ${ts(codexRate.resetWeeklyAt)}`);
  lines.push("");
  lines.push("### Claude Code");
  lines.push(`- Tokens: ${fmt(claudeTotals.total)} (in=${fmt(claudeTotals.input)}, cached=${fmt(claudeTotals.cached)}, out=${fmt(claudeTotals.output)})`);
  // 残量は claude.ai OAuth `/api/oauth/usage` 由来. accessToken は
  // ~/.claude/.credentials.json から都度読む (DB に保存しない)。
  // 取得失敗時は "-" にフォールバック.
  if (claudeUsage) {
    lines.push(`- 5H リミット残: ${pct(remain(claudeUsage.fiveHour?.utilization ?? null))}`);
    lines.push(`- 週間リミット残: ${pct(remain(claudeUsage.sevenDay?.utilization ?? null))}`);
    lines.push(`- 5H リセット: ${ts(claudeUsage.fiveHour?.resetsAtSec ?? null)}`);
    lines.push(`- 週間リセット: ${ts(claudeUsage.sevenDay?.resetsAtSec ?? null)}`);
    // モデル別 7日: Sonnet / Opus は Max 20x など上位プランで個別 quota あり
    if (claudeUsage.sevenDaySonnet) {
      lines.push(`- 週間 Sonnet 残: ${pct(remain(claudeUsage.sevenDaySonnet.utilization))} (リセット ${ts(claudeUsage.sevenDaySonnet.resetsAtSec)})`);
    }
    if (claudeUsage.sevenDayOpus) {
      lines.push(`- 週間 Opus 残: ${pct(remain(claudeUsage.sevenDayOpus.utilization))} (リセット ${ts(claudeUsage.sevenDayOpus.resetsAtSec)})`);
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
  const body = lines.join("\n").slice(0, 3900);

  const msgId = configGet(COST_MESSAGE_KEY);
  try {
    if (msgId) {
      const msg = await channel.messages.fetch(msgId);
      await msg.edit({ content: body });
      await notifyCostActivity({
        activityChannel,
        configGet,
        configSet,
        codexRate,
        claudeUsage,
      });
      return;
    }
  } catch {}
  const sent = await channel.send({ content: body });
  configSet(COST_MESSAGE_KEY, sent.id);

  await notifyCostActivity({
    activityChannel,
    configGet,
    configSet,
    codexRate,
    claudeUsage,
  });
}

async function notifyCostActivity(input: {
  activityChannel?: TextChannel | null;
  configGet: (k: string) => string | null;
  configSet: (k: string, v: string) => void;
  codexRate: Rate;
  claudeUsage: OAuthUsage | null;
}): Promise<void> {
  const { activityChannel, configGet, configSet, codexRate, claudeUsage } = input;
  if (!activityChannel) return;

  const codex5h = codexRate.used5h;
  const claude5h = claudeUsage?.fiveHour?.utilization ?? null;
  const available = codex5h !== null || claude5h !== null;
  const prevAvailability = configGet("cost_activity:available");
  if (prevAvailability === "0" && available) {
    await activityChannel.send("✅ cost usage is available again.");
  }
  configSet("cost_activity:available", available ? "1" : "0");

  await notifyHigh5hUsage(activityChannel, configGet, configSet, {
    provider: "Codex",
    used5h: codex5h,
    reset5hAt: codexRate.reset5hAt,
  });
  await notifyHigh5hUsage(activityChannel, configGet, configSet, {
    provider: "Claude",
    used5h: claude5h,
    reset5hAt: claudeUsage?.fiveHour?.resetsAtSec ?? null,
  });
}

async function notifyHigh5hUsage(
  activityChannel: TextChannel,
  configGet: (k: string) => string | null,
  configSet: (k: string, v: string) => void,
  input: { provider: string; used5h: number | null; reset5hAt: number | null },
): Promise<void> {
  if (input.used5h === null || input.used5h < 80) return;
  const resetBucket = input.reset5hAt ? String(input.reset5hAt) : localDayBucket();
  const key = `cost_activity:5h80:${input.provider.toLowerCase()}`;
  if (configGet(key) === resetBucket) return;
  configSet(key, resetBucket);
  await activityChannel.send(
    `⚠️ ${input.provider} 5H cost usage is ${input.used5h.toFixed(1)}%` +
    (input.reset5hAt ? ` (resets ${ts(input.reset5hAt)})` : ""),
  );
}

function localDayBucket(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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

function aggregateCodexRate(sessions: SessionRow[]): Rate {
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
  };
}

function readCodexRate(s: SessionRow): Rate | null {
  const p = findCodexLog(s);
  if (!p) return null;
  let latest: Rate | null = null;
  for (const line of readLines(p)) {
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    if (o?.type !== "event_msg" || o?.payload?.type !== "token_count") continue;
    latest = {
      used5h: nnull(o?.payload?.rate_limits?.primary?.used_percent),
      usedWeekly: nnull(o?.payload?.rate_limits?.secondary?.used_percent),
      reset5hAt: nnEpoch(o?.payload?.rate_limits?.primary?.resets_at),
      resetWeeklyAt: nnEpoch(o?.payload?.rate_limits?.secondary?.resets_at),
    };
  }
  return latest;
}

function nnull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function nnEpoch(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
}

function remain(used: number | null): number | null {
  if (used === null) return null;
  return Math.max(0, Math.min(100, 100 - used));
}

function pct(v: number | null): string {
  return v === null ? "-" : `${v.toFixed(1)}%`;
}

function fmt(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

function ts(epochSec: number | null): string {
  return epochSec === null ? "-" : `<t:${epochSec}:f> (<t:${epochSec}:R>)`;
}
