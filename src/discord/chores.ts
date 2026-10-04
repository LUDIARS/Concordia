import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, type Guild, type Message, type Interaction, type TextChannel, type ThreadChannel } from "discord.js";
import type { DiscordConfigRepo } from "../db/discord-repo.js";
import { canChooseChore, parseChoreMessage, type Chore } from "../chores/domain.js";
import { choreDiscordRequestKey, isChoreDiscordIntake } from "../chores/discord-intake.js";
import { createChoresForum } from "./chores-forum.js";

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
/** Notify only the author of a same-guild Discord request on its first result delivery. */
export function choreCompletionReply(run: Chore, guildId: string): {
  reply?: { messageReference: string; failIfNotExists: false };
  allowedMentions: { parse: []; repliedUser: boolean };
} {
  const source = /^discord:([0-9]+):([0-9]+)$/.exec(run.request_key);
  const notify = !run.discord_message_id && run.delivered_revision === 0
    && ["succeeded", "failed", "interrupted"].includes(run.status) && source?.[1] === guildId;
  return {
    ...(notify ? { reply: { messageReference: source![2], failIfNotExists: false as const } } : {}),
    allowedMentions: { parse: [], repliedUser: Boolean(notify) },
  };
}

export interface ChoresDiscord {
  handlesMessage: (message: Message) => boolean;
  message: (message: Message) => Promise<void>;
  handlesInteraction: (interaction: Interaction) => boolean;
  interaction: (interaction: Interaction) => Promise<void>;
  handlesThread: (thread: ThreadChannel) => boolean;
  thread: (thread: ThreadChannel) => Promise<void>;
  stopChores: () => void;
}
export async function startChoresDiscord(input: {
  guild: Guild; config: DiscordConfigRepo; parentId: string; baseUrl: string;
  allowed?: (userId: string) => boolean; log: { warn: (message: string) => void };
}): Promise<ChoresDiscord> {
  const { guild, config } = input;
  const saved = config.get("chores_channel_id");
  const existing = saved ? guild.channels.cache.get(saved) : [...guild.channels.cache.values()].find(c => c.type === ChannelType.GuildText && ["雑務", "雑務窓口"].includes(c.name));
  const channel: TextChannel = existing?.type === ChannelType.GuildText ? existing : await guild.channels.create({
    name: "雑務窓口", type: ChannelType.GuildText, parent: input.parentId,
    topic: "依頼を投稿すると専用ディレクトリでワンショット実行します。先頭 [codex] でCodex、既定はClaude。結果のOKで完了、Continueでセッション起動。",
  });
  if (channel.name !== "雑務窓口") await channel.setName("雑務窓口");
  config.set("chores_channel_id", channel.id);
  let stopped = false;
  const forum = await createChoresForum({ guild, config, parentId: input.parentId, windowId: channel.id, card: choreCard, stopped: () => stopped });
  const abort = new AbortController();
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
        await forum.mirror(run);
        if (stopped) break;
        const resultThread = await forum.resultChannel(run);
        if (resultThread) {
          const messageId = forum.forumCardId(run.id);
          if (!messageId) throw new Error("雑務の結果カードを照合できません。");
          await call(`/${run.id}/delivery`, { revision: run.revision, message_id: messageId });
          continue;
        }
        let old: Message | null = null;
        const windowCardId = forum.rememberedWindowCard(run.id) ?? run.discord_message_id;
        if (windowCardId) {
          try { old = await channel.messages.fetch(windowCardId); }
          catch (error) { if ((error as { code?: number }).code !== 10008) throw error; }
        }
        if (stopped) break;
        const posted = old ? await old.edit(card) : await channel.send({ ...card, ...choreCompletionReply(run, guild.id),
          nonce: BigInt(`0x${run.id.replaceAll("-", "").slice(0, 16)}`).toString(), enforceNonce: true });
        forum.rememberWindowCard(run.id, posted.id);
        await call(`/${run.id}/delivery`, { revision: run.revision, message_id: posted.id });
      }
    } catch (error) { if (!stopped) input.log.warn(`chores delivery failed: ${String(error)}`); }
    finally { delivering = false; }
  };
  const timer = setInterval(() => { void deliver(); }, 3000);
  timer.unref();
  const handlesMessage = (message: Message): boolean => isChoreDiscordIntake({
    guildId: message.guildId, channelId: message.channelId, parentId: message.channel.isThread() ? message.channel.parentId : null,
    messageId: message.id, isThread: message.channel.isThread(),
  }, { guildId: guild.id, windowId: channel.id, forumId: forum.forumId });
  const accept = async (message: Message): Promise<void> => {
    if (stopped || !handlesMessage(message) || message.author.bot || message.webhookId) return;
    if (input.allowed?.(message.author.id) !== true) {
      await message.reply({ content: "雑務の実行にはセッション起動権限が必要です。", allowedMentions: { parse: [] } });
      return;
    }
    const parsed = parseChoreMessage(message.content);
    if (!parsed.prompt) return;
    let run: Chore;
    try {
      const requestKey = choreDiscordRequestKey({ guildId: guild.id, messageId: message.id });
      forum.rememberSource(requestKey, message);
      ({ run } = await call<{ run: Chore }>("", { ...parsed, request_key: requestKey }));
    } catch (error) {
      if (!stopped) await message.reply({ content: `雑務の受付状態を確認できません: ${String(error).slice(0, 1500)}`, allowedMentions: { parse: [] } });
      return;
    }
    if (stopped) return;
    let recorded = true;
    try { await forum.mirror(run); }
    catch (error) { recorded = false; input.log.warn(`chores forum delivery unresolved run=${run.id}: ${String(error)}`); }
    const replyKey = `chores_accept_reply:${choreDiscordRequestKey({ guildId: guild.id, messageId: message.id })}`;
    if (!stopped && config.compareAndSwap(replyKey, null, "pending")) {
      await message.reply({ content: `雑務 ${run.id.slice(0, 8)} を受け付けました（${run.provider}）。${recorded ? "作業内容を雑務課に記録しました。" : "雑務課への投稿は照合待ちです。成果はWebUIから確認できます。"}完了後にOK / Continueを表示します。`, allowedMentions: { parse: [] } });
      config.compareAndSwap(replyKey, "pending", "done"); // Do not repeat a reply whose external result is unknown.
    }
  };
  return {
    handlesMessage,
    message: accept,
    handlesThread: (thread) => thread.guildId === guild.id && thread.parentId === forum.forumId,
    async thread(thread) {
      if (stopped || thread.guildId !== guild.id || thread.parentId !== forum.forumId) return;
      const starter = await thread.fetchStarterMessage();
      if (starter && !stopped) await accept(starter);
    },
    handlesInteraction: (interaction) => interaction.isButton() && interaction.customId.startsWith("chore:"),
    async interaction(interaction) {
      if (!interaction.isButton() || stopped) return;
      const match = /^chore:([0-9a-f-]{36}):(ok|continue)$/.exec(interaction.customId);
      if (!match) { await interaction.reply({ content: "不正な雑務ボタンです。", ephemeral: true }); return; }
      if (interaction.guildId !== guild.id || !forum.canOperate(match[1]!, interaction.channelId, interaction.message.id) || interaction.message.author.id !== guild.client.user.id
        || input.allowed?.(interaction.user.id) !== true) {
        await interaction.reply({ content: "この雑務を操作する権限がありません。", ephemeral: true });
        return;
      }
      await interaction.deferUpdate();
      try {
        const { run } = await call<{ run: Chore }>(`/${match[1]}/choice`, { action: match[2] });
        if (stopped) return; // The use case has already saved the selection; stop only prevents more Discord I/O.
        await interaction.editReply(choreCard(run));
        await forum.mirror(run);
        if (stopped) return;
        const originThread = await forum.resultChannel(run);
        const messageId = originThread ? forum.forumCardId(run.id)
          : forum.rememberedWindowCard(run.id) ?? (interaction.channelId === channel.id ? interaction.message.id : null);
        if (messageId) await call(`/${run.id}/delivery`, { revision: run.revision, message_id: messageId });
      } catch (error) { await interaction.followUp({ content: `状態を確認できません: ${String(error).slice(0, 1500)}`, ephemeral: true }); }
    },
    stopChores: () => { stopped = true; clearInterval(timer); abort.abort(); },
  };
}
