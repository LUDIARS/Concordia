/**
 * デイリーゴールの Discord 面: 入口チャンネル、 カードの配達 (1 ゴール 1 message の編集・9:00 の通知・
 * 4:00 のまとめ) と、 停止・まとめ再送の操作、 投稿の受付 (daily-goal-post-intake)。
 *
 * @implements spec/feature/daily-goal-run.md — 1. 投稿 / 5. カードの更新 / 6. 人間の停止 / 7. 9:00 の通知 / 8. まとめの投稿と再送 / CC-DG-INV-01
 *
 * 新規投稿は intent を先に保存してから送る。 結果不明は marker で既存投稿を照合し、
 * 見つからない間は同じカードを再送しない (sprint-dialogues の CC-SD-04 と同じ扱い)。
 */

import { createHash } from "node:crypto";
import { ChannelType, type Guild, type Interaction, type Message, type TextChannel } from "discord.js";
import type { DiscordConfigRepo } from "../db/discord-repo.js";
import type { DailyGoalSurfacePort } from "../daily-goal-run/surface-port.js";
import type { DailyGoalCard } from "../daily-goal-run/repository.js";
import { createDailyGoalPostIntake } from "./daily-goal-post-intake.js";
import {
  DAILY_GOAL_RESEND_PREFIX,
  DAILY_GOAL_STOP_PREFIX,
  cardMarker,
  renderDaySummaryCard,
  renderGoalCard,
  renderReminderCard,
} from "./daily-goal-card-render.js";
import { definiteDiscordRejection } from "./sprint-dialogues-surface.js";

export const DAILY_GOAL_CHANNEL_NAME = "デイリーゴール";
const CHANNEL_CONFIG_KEY = "daily_goal_channel_id";

/** 入口チャンネルを用意し、 説明 (topic) を投稿の書き方にそろえる。 */
async function ensureChannel(guild: Guild, config: DiscordConfigRepo, topic: string, log: { warn(message: string): void }): Promise<TextChannel> {
  const saved = config.get(CHANNEL_CONFIG_KEY);
  const known = saved ? guild.channels.cache.get(saved) : [...guild.channels.cache.values()].find((c) => c.type === ChannelType.GuildText && c.name === DAILY_GOAL_CHANNEL_NAME);
  const channel: TextChannel = known?.type === ChannelType.GuildText ? known : await guild.channels.create({
    name: DAILY_GOAL_CHANNEL_NAME, type: ChannelType.GuildText, topic,
  });
  // デイリーゴールはカテゴリを持たないチャンネル (2026-10-10 neco 指示)。
  if (channel.parentId) await channel.setParent(null, { reason: "daily goal channel moved out of category" });
  if (channel.topic !== topic) await channel.setTopic(topic).catch((error) => log.warn(`daily goal channel topic update failed: ${String(error)}`));
  config.set(CHANNEL_CONFIG_KEY, channel.id);
  return channel;
}

export interface DailyGoalDiscord {
  handlesInteraction(interaction: Interaction): boolean;
  interaction(interaction: Interaction): Promise<void>;
  /** デイリーゴールチャンネル (とその中のスレッド) の投稿か。 */
  handlesMessage(message: Message): boolean;
  message(message: Message): Promise<void>;
  messageUpdated(message: Message): Promise<void>;
  stop(): void;
}

export async function startDailyGoalDiscord(input: {
  guild: Guild; config: DiscordConfigRepo; port: DailyGoalSurfacePort;
  log: { warn(message: string): void };
}): Promise<DailyGoalDiscord> {
  const { port, guild } = input;
  const channel = await ensureChannel(guild, input.config, port.channelTopic(), input.log);
  const intake = createDailyGoalPostIntake({ guild, channelId: channel.id, port, log: input.log });
  let stopped = false;
  let busy = false;

  const render = (card: DailyGoalCard) => {
    const content = port.cards.content(card, Date.now());
    if (!content) return null;
    if (content.kind === "goal") return renderGoalCard(card.id, content.goalId, content.view);
    if (content.kind === "reminder") return renderReminderCard(card.id, content.view);
    return renderDaySummaryCard(card.id, content.date, content.view);
  };

  /** 結果不明の新規投稿を marker で照合する。 見つからなければ unknown のまま残す (再送しない)。 */
  const reconcileUnknown = async (): Promise<void> => {
    for (const card of port.cards.unknown()) {
      if (stopped) return;
      const recent = await channel.messages.fetch({ limit: 100 });
      const found = [...recent.values()].find((m) => m.author.id === guild.client.user.id && !m.webhookId && m.content.endsWith(cardMarker(card.id)));
      if (found) port.cards.saved(card.id, 0, channel.id, found.id);
    }
  };

  const deliver = async (): Promise<void> => {
    if (busy || stopped || !port.isEnabled()) return;
    busy = true;
    try {
      await reconcileUnknown();
      for (const card of port.cards.pending(Date.now())) {
        if (stopped) break;
        const message = render(card);
        if (!message) continue;
        try {
          if (card.messageId) {
            const existing = await channel.messages.fetch(card.messageId);
            await existing.edit(message);
            port.cards.saved(card.id, card.revision, channel.id, existing.id);
            continue;
          }
          if (!port.cards.claim(card.id, channel.id)) continue;
          const posted = await channel.send({ ...message, nonce: BigInt(`0x${createHash("sha256").update(card.id).digest("hex").slice(0, 15)}`).toString(), enforceNonce: true });
          port.cards.saved(card.id, card.revision, channel.id, posted.id);
        } catch (error) {
          // 編集は冪等なので後で再試行する。新規投稿は明確な拒否のときだけ intent を戻す。
          if (card.messageId || definiteDiscordRejection(error)) port.cards.rejected(card.id, String(error), Date.now());
          else port.cards.unknownResult(card.id, String(error));
        }
      }
    } catch (error) {
      if (!stopped) input.log.warn(`daily goal card delivery failed: ${String(error)}`);
    } finally { busy = false; }
  };
  const timer = setInterval(() => { void deliver(); }, 5_000);
  timer.unref?.();

  const actorOf = (i: Interaction) => ({
    userId: i.user.id, guildId: i.guildId ?? "", channelId: i.channelId ?? "", isBot: i.user.bot, isWebhook: false,
  });

  return {
    handlesInteraction: (i) => i.isButton() && i.customId.startsWith("dg:"),
    async interaction(i) {
      if (stopped || !i.isButton()) return;
      if (!port.isEnabled()) {
        await i.reply({ content: "デイリーゴール自走は設定で無効です。", ephemeral: true });
        return;
      }
      if (i.guildId !== guild.id || !i.channelId) return;
      try {
        if (i.customId.startsWith(DAILY_GOAL_STOP_PREFIX)) {
          const goal = port.stop(i.customId.slice(DAILY_GOAL_STOP_PREFIX.length), actorOf(i));
          await i.reply({ content: `デイリーゴール ${goal.id} を停止しました。`, ephemeral: true });
        } else if (i.customId.startsWith(DAILY_GOAL_RESEND_PREFIX)) {
          await i.deferReply({ ephemeral: true });
          const day = await port.resendSummary(i.customId.slice(DAILY_GOAL_RESEND_PREFIX.length), actorOf(i));
          await i.editReply({ content: `${day.businessDate} のまとめを再送しました (日記: ${day.diaryState} / ノート: ${day.noteState})。` });
        } else {
          // 撤廃した候補カードのボタン。 登録は投稿でだけ行う。
          await i.reply({ content: "候補カードは廃止されました。デイリーゴールチャンネルへの投稿で登録してください。", ephemeral: true });
          return;
        }
        void deliver();
      } catch (error) {
        const content = (error as Error).message.slice(0, 1500);
        if (i.deferred) await i.editReply({ content }); else await i.reply({ content, ephemeral: true });
      }
    },
    handlesMessage: (message) => !stopped && intake.handles(message),
    message: async (message) => { if (!stopped) await intake.created(message); },
    messageUpdated: async (message) => { if (!stopped) await intake.updated(message); },
    stop() { stopped = true; clearInterval(timer); },
  };
}
