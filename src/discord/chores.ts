import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, type Guild, type Message, type Interaction, type TextChannel, type ThreadChannel } from "discord.js";
import type { DiscordConfigRepo } from "../db/discord-repo.js";
import { canChooseChore, type Chore } from "../chores/domain.js";
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

/**
 * 受付の返信。窓口は雑務課スレッドへの案内だけを返し、回答はスレッドに投稿する (2026-10-07 neco 指示)。
 * @implements CC-CHORES-FORUM AT-06
 */
export function acceptReplyText(run: Pick<Chore, "id" | "provider">, where: { fromForum: boolean; threadId: string | null }): string {
  const head = `雑務 ${run.id.slice(0, 8)} を受け付けました（${run.provider}）。`;
  if (where.fromForum) return `${head}作業と回答はこのスレッドに投稿します。完了後にOK / Continueを表示します。`;
  if (where.threadId) return `${head}作業と回答は雑務課の <#${where.threadId}> に投稿します。`;
  return `${head}雑務課への投稿は照合待ちです。成果はWebUIから確認できます。`;
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
  guild: Guild; config: DiscordConfigRepo; baseUrl: string;
  allowed?: (userId: string) => boolean; log: { warn: (message: string) => void };
}): Promise<ChoresDiscord> {
  const { guild, config } = input;
  // Cc v5: 窓口チャンネルは依頼窓口 (desk.ts) が「依頼窓口」へ改名して引き継ぐ。ここでは作らず・改名せず、
  // 既存の雑務 run の窓口カードの編集にだけ使う (2026-11-24 neco 決定「依頼窓口にまとめる」)。
  const saved = config.get("chores_channel_id");
  const existing = saved ? guild.channels.cache.get(saved) ?? await guild.channels.fetch(saved).catch(() => null) : null;
  const channel: TextChannel | null = existing?.type === ChannelType.GuildText ? existing : null;
  let stopped = false;
  const forum = await createChoresForum({ guild, config, windowId: channel?.id ?? "", card: choreCard, stopped: () => stopped });
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
  /** 窓口の依頼者へ、最初の結果が出たときだけ雑務課スレッドへの案内を返信する (回答本文は窓口に出さない)。 */
  const noticeWindowResult = async (run: Chore, threadId: string): Promise<void> => {
    const reply = choreCompletionReply(run, guild.id);
    if (!reply.reply || !channel) return;
    const noticeKey = `chores_window_notice:${run.id}`;
    // 結果不明の外部投稿は繰り返さない (pending のまま残す)。
    if (!config.compareAndSwap(noticeKey, null, "pending")) return;
    await channel.send({ content: `雑務 ${run.id.slice(0, 8)} の回答を <#${threadId}> に投稿しました。`, ...reply });
    config.compareAndSwap(noticeKey, "pending", "done");
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
          if (forum.isWindowOrigin(run)) await noticeWindowResult(run, resultThread.id);
          await call(`/${run.id}/delivery`, { revision: run.revision, message_id: messageId });
          continue;
        }
        // 窓口チャンネルを照合できなければ、成果は WebUI (/desk の「過去の雑務」) で読める。配達は次の周回で試す。
        if (!channel) continue;
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
  return {
    // Cc v5: 新規受付は依頼窓口 (desk.ts) が持つ。窓口・雑務課フォーラムの投稿は雑務として受けない。
    handlesMessage: () => false,
    message: async () => undefined,
    handlesThread: () => false,
    thread: async () => undefined,
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
          : forum.rememberedWindowCard(run.id) ?? (interaction.channelId === channel?.id ? interaction.message.id : null);
        if (messageId) await call(`/${run.id}/delivery`, { revision: run.revision, message_id: messageId });
      } catch (error) { await interaction.followUp({ content: `状態を確認できません: ${String(error).slice(0, 1500)}`, ephemeral: true }); }
    },
    stopChores: () => { stopped = true; clearInterval(timer); abort.abort(); },
  };
}
