import { ChannelType, type ForumChannel, type Guild, type Message, type ThreadChannel } from "discord.js";
import { z } from "zod";
import type { DiscordConfigRepo } from "../db/discord-repo.js";
import type { Chore } from "../chores/domain.js";

const addressSchema = z.object({
  guildId: z.string(), originChannelId: z.string(), originMessageId: z.string(),
  threadId: z.string().nullable(), cardId: z.string().nullable(),
  phase: z.enum(["creating", "known", "posting", "editing"]),
  cardRevision: z.number().int().nonnegative(), pendingContent: z.string().nullable(),
}).strict();
type Address = z.infer<typeof addressSchema>;

/** Owns Discord delivery addresses, never chore execution state.
 * @implements CC-CHORES-FORUM AT-01 AT-02 AT-03 AT-04
 */
export async function createChoresForum(input: {
  guild: Guild; config: DiscordConfigRepo; parentId: string; windowId: string;
  card: (run: Chore) => { content: string }; stopped: () => boolean;
}): Promise<{
  forumId: string;
  rememberSource: (requestKey: string, message: Message) => void;
  mirror: (run: Chore) => Promise<void>;
  forumCardId: (runId: string) => string | null;
  resultChannel: (run: Chore) => Promise<ThreadChannel | null>;
  canOperate: (runId: string, channelId: string, messageId: string) => boolean;
  rememberedWindowCard: (runId: string) => string | null;
  rememberWindowCard: (runId: string, messageId: string) => void;
}> {
  const { guild, config } = input;
  const saved = config.get("chores_forum_id");
  const candidate = saved ? guild.channels.cache.get(saved) ?? await guild.channels.fetch(saved) : undefined;
  if (saved && candidate?.type !== ChannelType.GuildForum) throw new Error("保存した雑務課フォーラムを照合できません。");
  const existing = candidate?.type === ChannelType.GuildForum ? candidate
    : [...guild.channels.cache.values()].find(c => c.type === ChannelType.GuildForum && c.name === "雑務課" && c.parentId === input.parentId);
  let forum: ForumChannel;
  if (existing?.type === ChannelType.GuildForum) forum = existing;
  else {
    if (!config.compareAndSwap("chores_forum_creation", null, "pending")) throw new Error("雑務課フォーラム作成の結果が不明です。既存チャンネルを照合してください。");
    forum = await guild.channels.create({
      name: "雑務課", type: ChannelType.GuildForum, parent: input.parentId,
      topic: "作業内容と結果を依頼ごとのスレッドに残します。ここへの新しい作業投稿からも起動できます。雑務窓口でも依頼できます。",
    });
  }
  config.set("chores_forum_id", forum.id);
  config.delete("chores_forum_creation");
  const key = (id: string): string => `chores_forum_run:${id}`;
  const sourceKey = (request: string): string => `chores_discord_source:${request}`;
  const read = (id: string): Address | null => {
    const raw = config.get(key(id));
    return raw === null ? null : addressSchema.parse(JSON.parse(raw));
  };
  const preserveConfirmedAddress = (id: string, before: Address, after: Address): Address => {
    if (config.compareAndSwap(key(id), JSON.stringify(before), JSON.stringify(after))) return after;
    const current = read(id);
    if (current?.threadId === after.threadId && (after.cardId === null || current.cardId === after.cardId)) return current;
    throw new Error("確認済みの雑務投稿後に所有権が変わりました。投稿先を照合してください。");
  };
  const assertActive = (): void => { if (input.stopped()) throw new Error("雑務のDiscord受付は停止しています。"); };
  const threadById = async (id: string): Promise<ThreadChannel> => {
    const thread = await guild.channels.fetch(id);
    if (!thread?.isThread() || thread.guildId !== guild.id || thread.parentId !== forum.id) throw new Error("雑務の作業スレッドを照合できません。");
    return thread;
  };
  const ownsCard = (message: Message, run: Chore): boolean => message.author.id === guild.client.user.id
    && message.components.some(row => "components" in row && row.components.some(component => "customId" in component && component.customId === `chore:${run.id}:ok`));
  const knownThread = async (run: Chore): Promise<{ thread: ThreadChannel; address: Address }> => {
    assertActive();
    let address = read(run.id);
    if (!address) {
      const source = config.get(sourceKey(run.request_key));
      const origin = source ? z.object({ channelId: z.string(), messageId: z.string(), forum: z.boolean() }).strict().parse(JSON.parse(source)) : null;
      address = { guildId: guild.id, originChannelId: origin?.channelId ?? input.windowId, originMessageId: origin?.messageId ?? "",
        threadId: origin?.forum ? origin.channelId : null, cardId: null, phase: origin?.forum ? "known" : "creating", cardRevision: 0, pendingContent: null };
      if (!config.compareAndSwap(key(run.id), null, JSON.stringify(address))) throw new Error("雑務の投稿先を別の処理が照合中です。");
      if (!address.threadId) {
        // A saved creating marker prevents blind replay after an unknown Discord outcome.
        assertActive();
        const thread = await forum.threads.create({ name: `雑務-${run.id.slice(0, 8)}`, message: input.card(run) });
        address = preserveConfirmedAddress(run.id, address, { ...address, threadId: thread.id, phase: "known" });
        const starter = await thread.fetchStarterMessage();
        if (starter && ownsCard(starter, run) && !address.cardId) address = preserveConfirmedAddress(run.id, address, { ...address, cardId: starter.id });
        return { thread, address };
      }
    }
    if (address.guildId !== guild.id) throw new Error("別guildの雑務投稿先は使用できません。");
    if (!address.threadId) {
      // Only adopt a unique confirmed thread. Absence in the active listing is not proof that creation failed.
      const active = await forum.threads.fetchActive();
      const candidates = [...active.threads.values()].filter(t => t.name === `雑務-${run.id.slice(0, 8)}` && t.parentId === forum.id);
      const matches: { thread: ThreadChannel; message: Message }[] = [];
      for (const thread of candidates) { const message = await thread.fetchStarterMessage(); if (message && ownsCard(message, run)) matches.push({ thread, message }); }
      if (matches.length !== 1) throw new Error("雑務フォーラム作成の結果が不明です。保存済み成果を確認し、投稿先を照合してください。");
      address = preserveConfirmedAddress(run.id, address, { ...address, threadId: matches[0]!.thread.id, cardId: matches[0]!.message.id, phase: "known" });
      return { thread: matches[0]!.thread, address };
    }
    return { thread: await threadById(address.threadId), address };
  };
  const updateCard = async (run: Chore, message: Message): Promise<void> => {
    assertActive();
    const raw = config.get(key(run.id));
    if (!raw) throw new Error("雑務カードの保存先が失われました。");
    let address = addressSchema.parse(JSON.parse(raw));
    if (address.cardId !== message.id) throw new Error("雑務カードの所有権が変わりました。");
    if (address.phase === "editing") {
      if (message.content !== address.pendingContent) throw new Error("雑務カード更新の結果が不明です。投稿内容を照合してください。");
      address = { ...address, phase: "known", pendingContent: null };
      if (!config.compareAndSwap(key(run.id), raw, JSON.stringify(address))) throw new Error("別の処理が雑務カードを照合中です。");
    }
    if (address.phase !== "known") throw new Error("雑務カードへの投稿は照合中です。");
    if (address.cardRevision >= run.revision) return; // Do not overwrite newer state after reconnect.
    const expected = JSON.stringify(address);
    const card = input.card(run);
    const editing: Address = { ...address, phase: "editing", cardRevision: run.revision, pendingContent: card.content };
    if (!config.compareAndSwap(key(run.id), expected, JSON.stringify(editing))) throw new Error("雑務カードの所有権が変わりました。");
    assertActive();
    await message.edit(card);
    // A confirmed edit is saved even if the owner stopped while waiting on Discord.
    if (!config.compareAndSwap(key(run.id), JSON.stringify(editing), JSON.stringify({ ...editing, phase: "known", pendingContent: null }))) throw new Error("雑務カード更新後の所有権を照合してください。");
  };
  let tail: Promise<void> = Promise.resolve();
  const mirror = (run: Chore): Promise<void> => {
    const operation = tail.then(async () => {
      const { thread, address } = await knownThread(run);
      assertActive();
      if (address.cardId) {
        const card = await thread.messages.fetch(address.cardId);
        if (!ownsCard(card, run)) throw new Error("雑務結果カードの所有者を照合できません。");
        await updateCard(run, card);
        return;
      }
      if (address.phase === "posting") {
        const messages = await thread.messages.fetch({ limit: 100 });
        const matches = [...messages.values()].filter(message => ownsCard(message, run));
        if (matches.length !== 1) throw new Error("雑務カード投稿の結果が不明です。元の作業スレッドで照合してください。");
        preserveConfirmedAddress(run.id, address, { ...address, cardId: matches[0]!.id, phase: "known", cardRevision: 0, pendingContent: null });
        await updateCard(run, matches[0]!);
        return;
      }
      // A failed starter fetch may follow a successful thread creation. Adopt that card before sending anything.
      const starter = await thread.fetchStarterMessage();
      if (starter && ownsCard(starter, run)) {
        preserveConfirmedAddress(run.id, address, { ...address, cardId: starter.id, phase: "known" });
        await updateCard(run, starter);
        return;
      }
      const posting: Address = { ...address, phase: "posting", cardRevision: run.revision, pendingContent: input.card(run).content };
      if (!config.compareAndSwap(key(run.id), JSON.stringify(address), JSON.stringify(posting))) throw new Error("雑務カード投稿の所有権が変わりました。");
      assertActive();
      const card = await thread.send(input.card(run));
      preserveConfirmedAddress(run.id, posting, { ...posting, cardId: card.id, phase: "known", pendingContent: null });
    });
    // Keep the serialized queue usable after a failed operation; its caller owns error reporting.
    tail = operation.catch(() => { /* The durable marker preserves an unknown external result. */ });
    return operation;
  };
  return {
    forumId: forum.id,
    rememberSource(requestKey, message) {
      const source = { channelId: message.channelId, messageId: message.id, forum: message.channel.isThread() };
      const encoded = JSON.stringify(source);
      if (!config.compareAndSwap(sourceKey(requestKey), null, encoded) && config.get(sourceKey(requestKey)) !== encoded) throw new Error("雑務の受付元が既存の依頼と一致しません。");
    },
    mirror,
    forumCardId: (runId) => read(runId)?.cardId ?? null,
    async resultChannel(run) {
      const source = config.get(sourceKey(run.request_key));
      if (!source) return null; // Historic receipts retain their original text-window destination.
      const origin = z.object({ channelId: z.string(), messageId: z.string(), forum: z.boolean() }).strict().parse(JSON.parse(source));
      if (!origin.forum) return null;
      return threadById(origin.channelId);
    },
    canOperate(runId, channelId, messageId) {
      const address = read(runId);
      if (channelId === input.windowId) {
        const savedCard = config.get(`chores_window_card:${runId}`);
        return (!address || address.originChannelId === input.windowId) && (!savedCard || savedCard === messageId);
      }
      return address?.guildId === guild.id && address.threadId === channelId && address.cardId === messageId;
    },
    rememberedWindowCard: (runId) => config.get(`chores_window_card:${runId}`),
    rememberWindowCard: (runId, messageId) => config.set(`chores_window_card:${runId}`, messageId),
  };
}
