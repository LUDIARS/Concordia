import { ChannelType, type Guild, type Message } from "discord.js";
import { z } from "zod";
import type { DiscordConfigRepo } from "../db/discord-repo.js";
import type { ObservationStore, ObservedRun } from "../cloud-observation/store.js";
import { observationCard } from "../cloud-observation/card.js";

const Binding = z.object({
  target: z.string(), attempt: z.string(), forum: z.string(), thread: z.string().nullable(),
  phase: z.enum(["creating", "known", "posting"]), cursor: z.number().int().nonnegative(),
}).strict();
type Binding = z.infer<typeof Binding>;

/** Durable Discord delivery state. Unknown creates/posts are not retried automatically. */
export function cloudForum(input: { guild: Guild; forumId: string; config: DiscordConfigRepo;
  store: ObservationStore; allowed: (userId: string) => boolean | Promise<boolean>; now: () => number;
  stopped: () => boolean }): {
    refresh: () => Promise<void>; handles: (message: Message) => boolean; answer: (message: Message) => Promise<void>;
  } {
  const key = (target: string, attempt: string): string => `cloud_observation_thread:${target}:${attempt}`;
  const read = (target: string, attempt: string): Binding | null => {
    const raw = input.config.get(key(target, attempt)); return raw ? Binding.parse(JSON.parse(raw)) : null;
  };
  const save = (before: Binding, after: Binding): void => {
    if (!input.config.compareAndSwap(key(before.target, before.attempt), JSON.stringify(before), JSON.stringify(after)))
      throw new Error("cloud_forum_ownership_changed");
  };
  const find = (threadId: string): Binding | null => {
    const raw = input.config.get(`cloud_observation_thread_index:${threadId}`);
    if (!raw) return null;
    const identity = z.object({ target: z.string(), attempt: z.string() }).parse(JSON.parse(raw));
    return read(identity.target, identity.attempt);
  };
  const active = (): void => { if (input.stopped()) throw new Error("cloud_forum_stopping"); };
  async function mirror(run: ObservedRun): Promise<void> {
    active();
    const forum = await input.guild.channels.fetch(input.forumId);
    if (forum?.type !== ChannelType.GuildForum) throw new Error("cloud_forum_unavailable");
    let binding = read(run.target, run.attempt);
    if (!binding) {
      binding = { target: run.target, attempt: run.attempt, forum: forum.id, thread: null, phase: "creating", cursor: 0 };
      if (!input.config.compareAndSwap(key(run.target, run.attempt), null, JSON.stringify(binding))) return;
      active();
      const thread = await forum.threads.create({ name: `${run.target} ${run.attempt}`.slice(0, 100),
        message: observationCard(run.state, input.now()) });
      const known: Binding = { ...binding, thread: thread.id, phase: "known" };
      save(binding, known); binding = known;
      input.config.set(`cloud_observation_thread_index:${thread.id}`, JSON.stringify({ target: run.target, attempt: run.attempt }));
    }
    if (binding.phase !== "known" || !binding.thread || binding.forum !== forum.id) return;
    const thread = await input.guild.channels.fetch(binding.thread);
    if (!thread?.isThread() || thread.parentId !== forum.id) throw new Error("cloud_forum_thread_mismatch");
    active();
    const starter = await thread.fetchStarterMessage();
    if (!starter) throw new Error("cloud_forum_card_missing");
    const latest = observationCard(run.state, input.now());
    if (starter.content !== latest.content) await starter.edit(latest);
    for (const event of input.store.events(run.target, run.attempt, binding.cursor)) {
      active();
      if (event.kind === "heartbeat") {
        const next: Binding = { ...binding, cursor: event.sequence }; save(binding, next); binding = next; continue;
      }
      const posting: Binding = { ...binding, phase: "posting" }; save(binding, posting);
      const preview = event.previewId ? input.store.preview(run.target, run.attempt, event.previewId) : null;
      if (event.previewId && !preview) throw new Error("cloud_forum_preview_missing");
      const card = observationCard({ ...run.state, lastEvent: event }, input.now());
      const sent = await thread.send({ ...card, ...(preview ? { files: [{ attachment: preview.bytes, name: preview.name }] } : {}) });
      if (event.kind === "question" && event.questionId) {
        input.config.set(`cloud_observation_question:${thread.id}:${sent.id}`, JSON.stringify({
          target: run.target, attempt: run.attempt, question: event.questionId,
        }));
      }
      const known: Binding = { ...posting, phase: "known", cursor: event.sequence }; save(posting, known); binding = known;
    }
  }
  let refreshing = false;
  return {
    async refresh() {
      if (refreshing || input.stopped()) return;
      refreshing = true;
      try {
        const errors: unknown[] = [];
        for (const run of input.store.list()) { try { await mirror(run); } catch (error) { errors.push(error); } }
        if (errors.length) throw new AggregateError(errors, "cloud_forum_delivery_incomplete");
      } finally { refreshing = false; }
    },
    handles: message => message.channel.isThread() && message.channel.parentId === input.forumId,
    async answer(message) {
      if (message.author.bot || !message.channel.isThread() || message.channel.parentId !== input.forumId) return;
      const match = /^\/回答\s+([A-Za-z0-9_-]{1,100})\s+([\s\S]{1,1000})$/.exec(message.content);
      const reference = message.reference;
      const raw = reference?.messageId && (!reference.channelId || reference.channelId === message.channelId)
        ? input.config.get(`cloud_observation_question:${message.channelId}:${reference.messageId}`) : null;
      const replied = raw ? z.object({ target: z.string(), attempt: z.string(), question: z.string() }).strict().parse(JSON.parse(raw)) : null;
      if (!match && !replied) return; // Ordinary discussion is not an execution instruction.
      if (!await input.allowed(message.author.id)) throw new Error("cloud_answer_forbidden");
      const binding = find(message.channelId);
      if (!binding || binding.thread !== message.channelId || binding.forum !== input.forumId) throw new Error("cloud_question_binding_missing");
      if (replied && (replied.target !== binding.target || replied.attempt !== binding.attempt)) throw new Error("cloud_question_binding_mismatch");
      active();
      input.store.answer(binding.target, binding.attempt, replied?.question ?? match![1]!,
        replied ? message.content : match![2]!, message.author.id, input.now());
      await message.reply({ content: "回答を保存しました。クラウド側の受領は別途確認します。", allowedMentions: { parse: [], repliedUser: false } });
    },
  };
}
