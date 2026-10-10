import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, type Guild, type Interaction, type Message, type TextChannel } from "discord.js";
import type { DiscordConfigRepo } from "../db/discord-repo.js";
import { isHumanAction, type HumanAction, type ManagementRequest } from "../management/domain.js";

/**
 * CDGD マネジメント層の人間向けカード (spec/feature/cdgd-management.md CC-MGMT-06)。
 * 依頼の状態は Cc が持ち、 ここは表示とボタンの受付だけを行う。
 */

export type DeliveryCard = ManagementRequest & { mission_name: string; actions: HumanAction[] };

const STATE_LABELS: Record<ManagementRequest["state"], string> = {
  waiting_human: "人間の判断待ち", rejected: "却下", queued: "起動待ち", launching: "起動中・登録待ち",
  launch_unknown: "起動結果不明・照合中", launch_failed: "起動失敗", attached: "既存依頼へ合流",
  dispatched: "作業中", execution_finished: "セッション終了・成果未記録", outcome_recorded: "成果記録済み・受入待ち",
  accepted: "受入済み", effect_confirmed: "効果あり", effect_not_met: "効果なし",
};

const ACTION_LABELS: Record<HumanAction, { label: string; style: ButtonStyle }> = {
  approve: { label: "承認", style: ButtonStyle.Primary },
  reject: { label: "却下", style: ButtonStyle.Danger },
  accept: { label: "受入", style: ButtonStyle.Primary },
  effect_confirmed: { label: "効果あり", style: ButtonStyle.Success },
  effect_not_met: { label: "効果なし", style: ButtonStyle.Secondary },
};

const CUSTOM_ID = /^mgmt:([0-9a-f-]{36}):([a-z_]+)$/;

export function managementCard(item: DeliveryCard): { content: string; components: ActionRowBuilder<ButtonBuilder>[]; allowedMentions: { parse: [] } } {
  const lines = [
    `**CDGD 依頼 ${item.request_key} — ${STATE_LABELS[item.state] ?? item.state}**`,
    `任務: ${item.mission_name} / 種別: ${item.kind} / 対象: ${item.project_code} ${item.target_key}`,
    `目的: ${item.purpose.slice(0, 400)}`,
    `完了条件: ${item.completion_criteria.slice(0, 300)}`,
    item.session_id ? `担当セッション: ${item.session_id}` : "",
    item.outcome_summary ? `成果: ${item.outcome_summary.slice(0, 600)}` : "",
    item.outcome_refs.length ? `参照: ${item.outcome_refs.slice(0, 5).join(" / ")}` : "",
    item.error ? `エラー: ${item.error.slice(0, 300)}` : "",
    "この依頼は AI (dots) の判断によるものです。承認・受入は人間の判断として記録されます。",
  ];
  const components = item.actions.length
    ? [new ActionRowBuilder<ButtonBuilder>().addComponents(item.actions.map((action) =>
      new ButtonBuilder().setCustomId(`mgmt:${item.id}:${action}`).setLabel(ACTION_LABELS[action].label).setStyle(ACTION_LABELS[action].style)))]
    : [];
  return { content: lines.filter(Boolean).join("\n").slice(0, 1900), components, allowedMentions: { parse: [] } };
}

export function parseManagementButton(customId: string): { id: string; action: HumanAction } | null {
  const match = CUSTOM_ID.exec(customId);
  if (!match || !isHumanAction(match[2])) return null;
  return { id: match[1]!, action: match[2] };
}

export interface ManagementDiscord {
  handlesInteraction: (interaction: Interaction) => boolean;
  interaction: (interaction: Interaction) => Promise<void>;
  stop: () => void;
}

export async function startManagementDiscord(input: {
  guild: Guild; config: DiscordConfigRepo; baseUrl: string;
  allowed?: (userId: string) => boolean; log: { warn: (message: string) => void };
}): Promise<ManagementDiscord> {
  const { guild, config } = input;
  const saved = config.get("management_channel_id");
  const existing = saved ? guild.channels.cache.get(saved) : guild.channels.cache.find((c) => c.type === ChannelType.GuildText && c.name === "cdgd管理");
  const channel: TextChannel = existing?.type === ChannelType.GuildText ? existing : await guild.channels.create({
    name: "cdgd管理", type: ChannelType.GuildText,
    topic: "CDGD マネジメント層 (dots) の依頼のうち、人間の判断・受入・効果確認が要るものを表示します。",
  });
  // cdgd管理はカテゴリを持たないチャンネル (2026-10-10 neco 指示)。
  if (channel.parentId) await channel.setParent(null, { reason: "management channel moved out of category" });
  config.set("management_channel_id", channel.id);
  const abort = new AbortController();
  let stopped = false;
  let delivering = false;
  const call = async <T>(path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${input.baseUrl}/v1/admin/management${path}`, {
      method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(8000)]),
    });
    const result = await response.json() as T & { error?: string; message?: string };
    if (!response.ok) throw new Error(result.message ?? result.error ?? `HTTP ${response.status}`);
    return result;
  };
  const deliver = async (): Promise<void> => {
    if (delivering || stopped) return;
    delivering = true;
    try {
      const { deliveries } = await call<{ deliveries: DeliveryCard[] }>("/deliveries");
      for (const item of deliveries) {
        if (stopped) break;
        const card = managementCard(item);
        let old: Message | null = null;
        if (item.discord_message_id) {
          try { old = await channel.messages.fetch(item.discord_message_id); }
          catch (error) { if ((error as { code?: number }).code !== 10008) throw error; }
        }
        if (stopped) break;
        // 保存済みの revision を送り、 送信と記録の間で落ちても同じ nonce で重複投稿を抑える。
        const posted = old ? await old.edit(card) : await channel.send({ ...card,
          nonce: BigInt(`0x${item.id.replaceAll("-", "").slice(0, 15)}`).toString(), enforceNonce: true });
        await call(`/requests/${item.id}/delivery`, { revision: item.revision, message_id: posted.id });
      }
    } catch (error) { if (!stopped) input.log.warn(`management delivery failed: ${String(error)}`); }
    finally { delivering = false; }
  };
  const timer = setInterval(() => { void deliver(); }, 3000);
  timer.unref();
  return {
    handlesInteraction: (interaction) => interaction.isButton() && interaction.customId.startsWith("mgmt:"),
    async interaction(interaction) {
      if (!interaction.isButton() || stopped) return;
      if (interaction.guildId !== guild.id || interaction.channelId !== channel.id || interaction.message.author.id !== guild.client.user.id
        || input.allowed?.(interaction.user.id) !== true) {
        await interaction.reply({ content: "この依頼を操作する権限がありません。", ephemeral: true });
        return;
      }
      const parsed = parseManagementButton(interaction.customId);
      if (!parsed) { await interaction.reply({ content: "不正なボタンです。", ephemeral: true }); return; }
      await interaction.deferUpdate();
      try {
        // カードの再描画は配達ループが新しい revision で行う。
        await call(`/requests/${parsed.id}/${parsed.action}`, { actor: `discord:${interaction.user.id}` });
      } catch (error) {
        await interaction.followUp({ content: `操作できませんでした: ${String(error).slice(0, 1500)}`, ephemeral: true });
      }
    },
    stop: () => { stopped = true; clearInterval(timer); abort.abort(); },
  };
}
