import type { TextChannel } from "discord.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import { type OAuthUsage } from "../auth/anthropic-oauth-usage.js";
import { createChildLogger } from "../shared/logger.js";
// 集計 + 本文描画は cost/cost-report に集約 (Slack cost Canvas と共通の正本)。
import {
  collectCostReport,
  renderCostReportMarkdown,
  type CostRate,
  type CostTimestampFormat,
} from "../cost/cost-report.js";

const oauthUsageLog = createChildLogger("cost-channel.oauth-usage");

const COST_MESSAGE_KEY = "cost_status_message_id";

type Rate = CostRate;

/** Discord は `<t:..>` トークンでクライアント側ローカル時刻 / 相対表示にする。 */
const DISCORD_TS_FORMAT: CostTimestampFormat = {
  updated: (nowSec) => `<t:${nowSec}:R>`,
  at: (epochSec) => (epochSec === null ? "-" : `<t:${epochSec}:f> (<t:${epochSec}:R>)`),
};

export async function upsertCostChannelMessage(
  channel: TextChannel,
  sessionsRepo: SessionsRepo,
  configGet: (k: string) => string | null,
  configSet: (k: string, v: string) => void,
  activityChannel?: TextChannel | null,
): Promise<void> {
  const report = await collectCostReport(sessionsRepo, { oauthLog: oauthUsageLog });
  const codexRate = report.codexRate;
  const claudeUsage = report.claudeUsage;
  const body = renderCostReportMarkdown(report, DISCORD_TS_FORMAT, Math.floor(Date.now() / 1000)).slice(0, 3900);

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

function ts(epochSec: number | null): string {
  return epochSec === null ? "-" : `<t:${epochSec}:f> (<t:${epochSec}:R>)`;
}
