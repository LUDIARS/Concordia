/**
 * デイリーゴールチャンネルの投稿を daily-goal-run の投稿登録へ渡す Discord adapter。
 *
 * @implements spec/feature/daily-goal-run.md — 1. 目標を投稿する / 2. 聞き返し (元投稿のスレッド) / CC-DG-INV-01
 *
 * チャンネル直下の人間の投稿だけを登録に使う。 bot・webhook・system・Cc 自身の投稿は捨てる。
 * スレッド内の投稿は、 そのスレッドが下書きの聞き返しスレッドで投稿者が元投稿者のときだけ補足として読む
 * (その判定は use case が持つ)。 返信は use case の指示どおりに元投稿かスレッドへ 1 通出す。
 */

import type { Guild, Message } from "discord.js";
import type { IntakeResult } from "../daily-goal-run/post-intake.js";
import type { DailyGoalSurfacePort, SurfaceActor } from "../daily-goal-run/surface-port.js";

export type DailyGoalMessageRoute = "post" | "thread_reply" | "ignore";

export interface DailyGoalMessageFacts {
  guildId: string | null;
  channelId: string;
  /** スレッド内の投稿ならスレッドの親チャンネル。 */
  parentId: string | null;
  isThread: boolean;
  authorId: string;
  authorBot: boolean;
  webhookId: string | null;
  system: boolean;
}

/** 投稿の経路を決める (純関数)。 */
export function routeDailyGoalMessage(message: DailyGoalMessageFacts, scope: { guildId: string; channelId: string; selfId: string | null }): DailyGoalMessageRoute {
  if (message.guildId !== scope.guildId) return "ignore";
  if (message.authorBot || message.webhookId || message.system || message.authorId === scope.selfId) return "ignore";
  if (!message.isThread && message.channelId === scope.channelId) return "post";
  if (message.isThread && message.parentId === scope.channelId) return "thread_reply";
  return "ignore";
}

const REPLY_LIMIT = 1990;
const clip = (text: string) => (text.length <= REPLY_LIMIT ? text : `${text.slice(0, REPLY_LIMIT - 1)}…`);

export interface DailyGoalPostIntakeAdapter {
  /** このチャンネル (またはその中のスレッド) の投稿か。 対象なら他の ingress へ回さない。 */
  handles(message: Message): boolean;
  created(message: Message): Promise<void>;
  updated(message: Message): Promise<void>;
}

export function createDailyGoalPostIntake(input: {
  guild: Guild; channelId: string; port: DailyGoalSurfacePort; log: { warn(message: string): void };
}): DailyGoalPostIntakeAdapter {
  const { guild, port } = input;
  const facts = (message: Message): DailyGoalMessageFacts => ({
    guildId: message.guildId, channelId: message.channelId, isThread: message.channel.isThread(),
    parentId: message.channel.isThread() ? message.channel.parentId : null,
    authorId: message.author.id, authorBot: message.author.bot, webhookId: message.webhookId, system: message.system,
  });
  const route = (message: Message) => routeDailyGoalMessage(facts(message), { guildId: guild.id, channelId: input.channelId, selfId: guild.client.user?.id ?? null });
  const actorOf = (message: Message): SurfaceActor => ({
    userId: message.author.id, guildId: message.guildId ?? "", channelId: input.channelId, messageId: message.id,
    isBot: message.author.bot, isWebhook: !!message.webhookId,
  });

  /** use case の指示を Discord に出す。 スレッドが無ければ元投稿に作り、 下書きへ結び付ける。 */
  const apply = async (source: Message, result: IntakeResult, inThread: boolean): Promise<void> => {
    if (result.kind === "ignored") return;
    if (result.kind === "reply") {
      await source.reply({ content: clip(result.reply), allowedMentions: { parse: [] } });
      return;
    }
    if (inThread) {
      if (source.channel.isSendable()) await source.channel.send({ content: clip(result.reply), allowedMentions: { parse: [] } });
      return;
    }
    let threadId = result.threadId;
    if (!threadId) {
      const thread = source.thread ?? await source.startThread({ name: "デイリーゴールの読み取り", autoArchiveDuration: 1440 });
      port.intake.attachThread(result.draftId, thread.id);
      threadId = thread.id;
    }
    const thread = await guild.channels.fetch(threadId).catch(() => null);
    if (thread?.isThread()) await thread.send({ content: clip(result.reply), allowedMentions: { parse: [] } });
  };

  return {
    handles: (message) => {
      if (message.guildId !== guild.id) return false;
      const parent = message.channel.isThread() ? message.channel.parentId : null;
      return message.channelId === input.channelId || parent === input.channelId;
    },
    async created(message) {
      if (!port.isEnabled()) return;
      const kind = route(message);
      if (kind === "ignore") return;
      try {
        const result = kind === "post"
          ? await port.intake.post({ text: message.content, messageId: message.id, actor: actorOf(message) })
          : await port.intake.threadReply({ threadId: message.channelId, text: message.content, actor: actorOf(message) });
        await apply(message, result, kind === "thread_reply");
      } catch (error) {
        input.log.warn(`daily goal post intake failed message=${message.id}: ${String(error)}`);
      }
    },
    async updated(message) {
      if (!port.isEnabled() || route(message) !== "post") return;
      try {
        const result = await port.intake.edited({ text: message.content, messageId: message.id, actor: actorOf(message) });
        await apply(message, result, false);
      } catch (error) {
        input.log.warn(`daily goal edited post intake failed message=${message.id}: ${String(error)}`);
      }
    },
  };
}
