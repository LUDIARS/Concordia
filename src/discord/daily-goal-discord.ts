/**
 * デイリーゴールの Discord 面: カードの配達 (1 ゴール 1 message の編集) と、 停止・候補確定の操作。
 *
 * @implements spec/feature/daily-goal-run.md — 1. 候補カード / 5. カードの更新 / 6. 人間の停止 / CC-DG-INV-01
 *
 * 新規投稿は intent を先に保存してから送る。 結果不明は marker で既存投稿を照合し、
 * 見つからない間は同じカードを再送しない (sprint-dialogues の CC-SD-04 と同じ扱い)。
 */

import { createHash } from "node:crypto";
import { ChannelType, type Guild, type Interaction, type TextChannel } from "discord.js";
import type { DiscordConfigRepo } from "../db/discord-repo.js";
import { parsePermissionText } from "../daily-goal-run/confirmation-policy.js";
import type { DailyGoalSurfacePort } from "../daily-goal-run/surface-port.js";
import type { DailyGoalCard } from "../daily-goal-run/repository.js";
import { confirmReply, splitIds, splitLines } from "./commands/daily-goal.js";
import {
  DAILY_GOAL_CANDIDATE_MODAL_PREFIX,
  DAILY_GOAL_CANDIDATE_PREFIX,
  DAILY_GOAL_STOP_PREFIX,
  candidateModal,
  cardMarker,
  renderCandidateCard,
  renderGoalCard,
} from "./daily-goal-card-render.js";
import { definiteDiscordRejection } from "./sprint-dialogues-surface.js";

export const DAILY_GOAL_CHANNEL_NAME = "デイリーゴール";
const CHANNEL_CONFIG_KEY = "daily_goal_channel_id";

async function ensureChannel(guild: Guild, config: DiscordConfigRepo, parentId: string): Promise<TextChannel> {
  const saved = config.get(CHANNEL_CONFIG_KEY);
  const known = saved ? guild.channels.cache.get(saved) : [...guild.channels.cache.values()].find((c) => c.type === ChannelType.GuildText && c.name === DAILY_GOAL_CHANNEL_NAME);
  const channel: TextChannel = known?.type === ChannelType.GuildText ? known : await guild.channels.create({
    name: DAILY_GOAL_CHANNEL_NAME, type: ChannelType.GuildText, parent: parentId,
    topic: "デイリーゴールの確認カード (1 ゴール 1 枚、1 時間ごとに更新) と朝の候補カード。/co-daily-goal で確定します。",
  });
  config.set(CHANNEL_CONFIG_KEY, channel.id);
  return channel;
}

export interface DailyGoalDiscord {
  handlesInteraction(interaction: Interaction): boolean;
  interaction(interaction: Interaction): Promise<void>;
  stop(): void;
}

export async function startDailyGoalDiscord(input: {
  guild: Guild; config: DiscordConfigRepo; parentId: string; port: DailyGoalSurfacePort;
  log: { warn(message: string): void };
}): Promise<DailyGoalDiscord> {
  const { port, guild } = input;
  const channel = await ensureChannel(guild, input.config, input.parentId);
  let stopped = false;
  let busy = false;

  const render = (card: DailyGoalCard) => {
    const content = port.cards.content(card, Date.now());
    if (!content) return null;
    return content.kind === "goal" ? renderGoalCard(card.id, content.goalId, content.view) : renderCandidateCard(card.id, content.candidate, content.view);
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
    handlesInteraction: (i) => (i.isButton() && i.customId.startsWith("dg:")) || (i.isModalSubmit() && i.customId.startsWith(DAILY_GOAL_CANDIDATE_MODAL_PREFIX)),
    async interaction(i) {
      if (stopped || (!i.isButton() && !i.isModalSubmit())) return;
      if (!port.isEnabled()) {
        await i.reply({ content: "デイリーゴール自走は設定で無効です。", ephemeral: true });
        return;
      }
      if (i.guildId !== guild.id || !i.channelId) return;
      if (i.isButton() && i.customId.startsWith(DAILY_GOAL_STOP_PREFIX)) {
        try {
          const goal = port.stop(i.customId.slice(DAILY_GOAL_STOP_PREFIX.length), actorOf(i));
          await i.reply({ content: `デイリーゴール ${goal.id} を停止しました。`, ephemeral: true });
          void deliver();
        } catch (error) { await i.reply({ content: (error as Error).message.slice(0, 1500), ephemeral: true }); }
        return;
      }
      if (i.isButton() && i.customId.startsWith(DAILY_GOAL_CANDIDATE_PREFIX)) {
        const candidate = port.candidate(i.customId.slice(DAILY_GOAL_CANDIDATE_PREFIX.length));
        if (!candidate) { await i.reply({ content: "この候補は見つかりません。/co-daily-goal で確定してください。", ephemeral: true }); return; }
        await i.showModal(candidateModal(candidate));
        return;
      }
      if (i.isModalSubmit()) {
        const candidate = port.candidate(i.customId.slice(DAILY_GOAL_CANDIDATE_MODAL_PREFIX.length));
        if (!candidate) { await i.reply({ content: "この候補は見つかりません。/co-daily-goal で確定してください。", ephemeral: true }); return; }
        const result = port.confirm({
          draft: {
            project: candidate.project,
            goalText: i.fields.getTextInputValue("goal"),
            acceptance: splitLines(i.fields.getTextInputValue("acceptance")),
            actioTaskIds: splitIds(i.fields.getTextInputValue("actio_tasks")),
            permissions: parsePermissionText(i.fields.getTextInputValue("permissions")),
          },
          actor: actorOf(i),
          receiptId: i.id,
        });
        await i.reply({ content: confirmReply(result, (goal) => port.launchAtFor(goal)), ephemeral: true, allowedMentions: { parse: [] } });
        if (result.ok && result.created) port.launchSoon();
      }
    },
    stop() { stopped = true; clearInterval(timer); },
  };
}
