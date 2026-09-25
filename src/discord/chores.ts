import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, type Guild, type Message, type Interaction, type TextChannel } from "discord.js";
import type { DiscordConfigRepo } from "../db/discord-repo.js";
import { canChooseChore, parseChoreMessage, type Chore } from "../chores/domain.js";

export function choreCard(run: Chore): { content: string; components: ActionRowBuilder<ButtonBuilder>[]; allowedMentions: { parse: [] } } {
  const labels: Record<Chore["status"], string> = { queued: "受付済み", running: "実行中", succeeded: "完了・確認待ち", failed: "実行失敗",
    interrupted: "結果不明・要確認", acknowledged: "確認済み", continuing: "継続起動・照合待ち", continued: "継続セッション起動済み" };
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`chore:${run.id}:ok`).setLabel("OK").setStyle(ButtonStyle.Secondary).setDisabled(!canChooseChore(run.status, "ok")),
    new ButtonBuilder().setCustomId(`chore:${run.id}:continue`).setLabel("Continue").setStyle(ButtonStyle.Primary).setDisabled(!canChooseChore(run.status, "continue")),
  );
  return { content: [
    `**雑務 ${run.id.slice(0, 8)} — ${labels[run.status]}** (${run.provider})`,
    run.prompt.slice(0, 250), run.output.slice(0, 1000), run.error?.slice(0, 350),
    run.output.length > 1000 ? "全文はWebUIの「雑務」で確認できます。" : "",
    run.spawn_id ? `継続起動ID: ${run.spawn_id}` : "",
  ].filter(Boolean).join("\n\n"), components: [buttons], allowedMentions: { parse: [] } };
}
export interface ChoresDiscord {
  handlesMessage: (message: Message) => boolean;
  message: (message: Message) => Promise<void>;
  handlesInteraction: (interaction: Interaction) => boolean;
  interaction: (interaction: Interaction) => Promise<void>;
  stopChores: () => void;
}
export async function startChoresDiscord(input: {
  guild: Guild; config: DiscordConfigRepo; parentId: string; baseUrl: string;
  allowed?: (userId: string) => boolean; log: { warn: (message: string) => void };
}): Promise<ChoresDiscord> {
  const { guild, config } = input;
  const saved = config.get("chores_channel_id");
  const existing = saved ? guild.channels.cache.get(saved) : guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.name === "雑務");
  const channel: TextChannel = existing?.type === ChannelType.GuildText ? existing : await guild.channels.create({
    name: "雑務", type: ChannelType.GuildText, parent: input.parentId,
    topic: "依頼を投稿すると専用ディレクトリでワンショット実行します。先頭 [codex] でCodex、既定はClaude。結果のOKで完了、Continueでセッション起動。",
  });
  config.set("chores_channel_id", channel.id);
  const abort = new AbortController();
  let stopped = false;
  let delivering = false;
  const call = async <T>(path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${input.baseUrl}/v1/chores${path}`, {
      method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(8000)]),
    });
    const result = await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
    return result;
  };
  const deliver = async (): Promise<void> => {
    if (delivering || stopped) return;
    delivering = true;
    try {
      const { runs } = await call<{ runs: Chore[] }>("/deliveries");
      for (const run of runs) {
        if (stopped) break;
        const card = choreCard(run);
        let old: Message | null = null;
        if (run.discord_message_id) {
          try { old = await channel.messages.fetch(run.discord_message_id); }
          catch (error) { if ((error as { code?: number }).code !== 10008) throw error; }
        }
        if (stopped) break;
        const posted = old ? await old.edit(card) : await channel.send({ ...card,
          nonce: BigInt(`0x${run.id.replaceAll("-", "").slice(0, 16)}`).toString(), enforceNonce: true });
        await call(`/${run.id}/delivery`, { revision: run.revision, message_id: posted.id });
      }
    } catch (error) { if (!stopped) input.log.warn(`chores delivery failed: ${String(error)}`); }
    finally { delivering = false; }
  };
  const timer = setInterval(() => { void deliver(); }, 3000);
  timer.unref();
  return {
    handlesMessage: (message) => message.guildId === guild.id && message.channelId === channel.id,
    async message(message) {
      if (stopped || message.author.bot || message.webhookId) return;
      if (input.allowed?.(message.author.id) !== true) {
        await message.reply({ content: "雑務の実行にはセッション起動権限が必要です。", allowedMentions: { parse: [] } });
        return;
      }
      const parsed = parseChoreMessage(message.content);
      try {
        const { run } = await call<{ run: Chore }>("", { ...parsed, request_key: `discord:${guild.id}:${message.id}` });
        await message.reply({ content: `雑務 ${run.id.slice(0, 8)} を受け付けました（${run.provider}）。完了後にOK / Continueを表示します。`, allowedMentions: { parse: [] } });
      } catch (error) {
        await message.reply({ content: `雑務を受け付けられませんでした: ${String(error).slice(0, 1500)}`, allowedMentions: { parse: [] } });
      }
    },
    handlesInteraction: (interaction) => interaction.isButton() && interaction.customId.startsWith("chore:"),
    async interaction(interaction) {
      if (!interaction.isButton() || stopped) return;
      if (interaction.guildId !== guild.id || interaction.channelId !== channel.id || interaction.message.author.id !== guild.client.user.id
        || input.allowed?.(interaction.user.id) !== true) {
        await interaction.reply({ content: "この雑務を操作する権限がありません。", ephemeral: true });
        return;
      }
      const match = /^chore:([0-9a-f-]{36}):(ok|continue)$/.exec(interaction.customId);
      if (!match) { await interaction.reply({ content: "不正な雑務ボタンです。", ephemeral: true }); return; }
      await interaction.deferUpdate();
      try {
        const { run } = await call<{ run: Chore }>(`/${match[1]}/choice`, { action: match[2] });
        await interaction.editReply(choreCard(run));
        await call(`/${run.id}/delivery`, { revision: run.revision, message_id: interaction.message.id });
      } catch (error) { await interaction.followUp({ content: `状態を確認できません: ${String(error).slice(0, 1500)}`, ephemeral: true }); }
    },
    stopChores: () => { stopped = true; clearInterval(timer); abort.abort(); },
  };
}
