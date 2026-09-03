import type { TextChannel } from "discord.js";
import type { OAuthUsage } from "../auth/anthropic-oauth-usage.js";
import type { CostTimestampFormat } from "../cost/cost-report.js";
import type { ChatReadModel, CostRateSnapshot } from "../platform/chat-read-model.js";

const COST_MESSAGE_KEY = "cost_status_message_id";

type Rate = CostRateSnapshot;

const DISCORD_TS_FORMAT: CostTimestampFormat = {
  updated: (nowSec) => `<t:${nowSec}:R>`,
  at: (epochSec) => (epochSec === null ? "-" : `<t:${epochSec}:f> (<t:${epochSec}:R>)`),
};

export async function upsertCostChannelMessage(
  channel: TextChannel,
  readModel: ChatReadModel,
  configGet: (k: string) => string | null,
  configSet: (k: string, v: string) => void,
  activityChannel?: TextChannel | null,
): Promise<void> {
  const snapshot = await readModel.getCostSnapshot(DISCORD_TS_FORMAT, Math.floor(Date.now() / 1000));
  const body = snapshot.markdown.slice(0, 3900);

  const msgId = configGet(COST_MESSAGE_KEY);
  try {
    if (msgId) {
      const msg = await channel.messages.fetch(msgId);
      await msg.edit({ content: body, allowedMentions: { parse: [] } });
      await notifyCostActivity({
        activityChannel,
        configGet,
        configSet,
        codexRate: snapshot.codexRate,
        claudeUsage: snapshot.claudeUsage,
      });
      return;
    }
  } catch {}
  const sent = await channel.send({ content: body, allowedMentions: { parse: [] } });
  configSet(COST_MESSAGE_KEY, sent.id);

  await notifyCostActivity({
    activityChannel,
    configGet,
    configSet,
    codexRate: snapshot.codexRate,
    claudeUsage: snapshot.claudeUsage,
  });
}

/** モデル別週間枠 (Fable 等) の通知しきい値 (%)。 5H と同じ 80。 */
const SCOPED_WEEKLY_ALERT_PCT = 80;

export async function notifyCostActivity(input: {
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
    await activityChannel.send("Cost usage is available again.");
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
  // モデル別の週間枠 (Fable 等) は全体枠より先に尽きる (2026-09-03: 全体 57% で Fable 90%)。
  // 80% 以上ならリセット期間につき 1 回、活動チャンネルへ知らせる。
  for (const scoped of claudeUsage?.weeklyScoped ?? []) {
    await notifyHighScopedWeeklyUsage(activityChannel, configGet, configSet, scoped);
  }
}

async function notifyHighScopedWeeklyUsage(
  activityChannel: TextChannel,
  configGet: (k: string) => string | null,
  configSet: (k: string, v: string) => void,
  scoped: { label: string; utilization: number; resetsAtSec: number | null; severity: string | null },
): Promise<void> {
  if (scoped.utilization < SCOPED_WEEKLY_ALERT_PCT) return;
  const key = `cost_activity:weekly80:${encodeURIComponent(scoped.label.toLowerCase())}`;
  if (alreadyNotified(configGet(key), scoped.resetsAtSec)) return;
  const resetBucket = notifiedBucket(scoped.resetsAtSec);
  const content = `Claude ${scoped.label} weekly cost usage is ${scoped.utilization.toFixed(1)}%`
    + (scoped.severity ? ` [${scoped.severity}]` : "")
    + (scoped.resetsAtSec ? ` (resets ${ts(scoped.resetsAtSec)})` : "");
  await activityChannel.send({ content, allowedMentions: { parse: [] } });
  configSet(key, resetBucket);
}

async function notifyHigh5hUsage(
  activityChannel: TextChannel,
  configGet: (k: string) => string | null,
  configSet: (k: string, v: string) => void,
  input: { provider: string; used5h: number | null; reset5hAt: number | null },
): Promise<void> {
  if (input.used5h === null || input.used5h < 80) return;
  const key = `cost_activity:5h80:${input.provider.toLowerCase()}`;
  if (alreadyNotified(configGet(key), input.reset5hAt)) return;
  configSet(key, notifiedBucket(input.reset5hAt));
  await activityChannel.send(
    `${input.provider} 5H cost usage is ${input.used5h.toFixed(1)}%` +
    (input.reset5hAt ? ` (resets ${ts(input.reset5hAt)})` : ""),
  );
}

/**
 * 上流の `resets_at` は同じ窓でも秒が揺れる (実測: Claude 5H が 05:09:59 と 05:10:00、
 * 週間枠が 23:59:59 と 00:00:00 を往復)。 保存値との完全一致で重複判定していた頃は
 * 10 分ごとの更新のたびにバケットが変わり、リセットまで鳴り続けていた。
 * 「保存したリセット時刻をまだ過ぎていない」か「揺れの範囲で同じ窓」なら通知済みとみなす。
 */
const RESET_JITTER_SEC = 120;

function alreadyNotified(stored: string | null, resetAtSec: number | null): boolean {
  if (!stored) return false;
  const storedReset = Number(stored);
  if (Number.isFinite(storedReset) && storedReset > 0) {
    if (Math.floor(Date.now() / 1000) < storedReset) return true;
    return resetAtSec !== null && Math.abs(resetAtSec - storedReset) <= RESET_JITTER_SEC;
  }
  return stored === localDayBucket();
}

/** リセット時刻が読めない窓は「その日 1 回」に倒す。 */
function notifiedBucket(resetAtSec: number | null): string {
  return resetAtSec ? String(resetAtSec) : localDayBucket();
}

function localDayBucket(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function ts(epochSec: number | null): string {
  return epochSec === null ? "-" : `<t:${epochSec}:f> (<t:${epochSec}:R>)`;
}
