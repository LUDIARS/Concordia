import { createHash } from "node:crypto";
import type { Guild, ThreadChannel } from "discord.js";
import type { SprintDialoguesRepository } from "../sprint-dialogues/repository.js";
import { sprintCard, phaseNoticeText } from "./sprint-dialogues-card.js";
import { definiteDiscordRejection, findPosted, sprintForum, sprintThread } from "./sprint-dialogues-surface.js";

export function sprintDelivery(input: { guild: Guild; parentId: string; repo: SprintDialoguesRepository; origin: () => Promise<string>; stopped: () => boolean; log: { warn(message: string): void } }) {
  const { repo } = input;
  let busy = false;
  const threadById = async (id: string | null): Promise<ThreadChannel> => {
    if (!id) throw new Error("スプリントスレッドが未配達です。");
    const c = await input.guild.channels.fetch(id);
    if (!c?.isThread() || c.parentId !== repo.surface(input.guild.id).forumId) throw new Error("スプリントスレッドを確認できません。");
    if (c.archived && !input.stopped()) await c.setArchived(false);
    return c;
  };
  const postOnce = async (thread: ThreadChannel, marker: string, text: string, claim: () => boolean, delivered: () => void, rejected: () => void): Promise<void> => {
    if (await findPosted(thread, marker)) { delivered(); return; }
    if (input.stopped()) return;
    if (!claim()) throw new Error("配達結果が不明です。受付IDの投稿を照合してから復旧してください。");
    try {
      await thread.send({ content: `${text.slice(0, 1700)}\n\n${marker}`, allowedMentions: { parse: [] },
        ...(text.length > 1700 ? { files: [{ attachment: Buffer.from(text, "utf8"), name: "sprint-reply.txt" }] } : {}),
        nonce: BigInt(`0x${createHash("sha256").update(marker).digest("hex").slice(0, 16)}`).toString(), enforceNonce: true });
    } catch (error) { if (definiteDiscordRejection(error)) rejected(); throw error; }
    delivered();
  };
  return async (): Promise<void> => {
    if (busy || input.stopped()) return;
    busy = true;
    try {
      for (const d of repo.pending()) {
        if (input.stopped()) break;
        try {
          const origin = await input.origin();
          const forum = await sprintForum(input.guild, input.parentId, repo, input.stopped);
          if (input.stopped()) break;
          const thread = await sprintThread(forum, d, repo, origin, input.stopped);
          if (input.stopped()) break;
          const card = d.cardId ? await thread.messages.fetch(d.cardId) : await thread.fetchStarterMessage();
          if (input.stopped()) break;
          if (!card || card.webhookId || card.author.id !== input.guild.client.user.id) throw new Error("保存済み確認カードを取得できません。");
          await card.edit(sprintCard(d, origin));
          repo.saveCard(d.id, d.projection.revision, card.id);
        } catch (error) { repo.deliveryError(d.id, definiteDiscordRejection(error) ? 'failed' : 'unknown', String(error)); }
      }
      for (const n of repo.noticeDeliveries()) {
        if (input.stopped()) break;
        const d = repo.byId(n.dialogueId);
        if (!d || !repo.deliveryReady(d.id)) continue;
        try {
          const thread = await threadById(d.threadId);
          await postOnce(thread, `sprint-phase:${n.id}`, phaseNoticeText(n.projection, await input.origin()),
            () => repo.claimNotice(n.id), () => repo.noticeDelivered(n.id), () => repo.noticeRejected(n.id));
        } catch (error) { repo.deliveryError(d.id, definiteDiscordRejection(error) ? 'failed' : 'unknown', String(error)); }
      }
      for (const r of repo.resultDeliveries()) {
        if (input.stopped()) break;
        const d = repo.find(r.event.dialogueKey);
        if (!d || !repo.deliveryReady(d.id)) continue;
        try {
          const thread = await threadById(d.threadId);
          await postOnce(thread, `sprint-result:${r.event.eventId}`, `**${r.acknowledgement!.outcome === 'applied' ? '回答を反映しました' : '回答を反映できませんでした'} / 版 ${r.event.revision}**\n${r.acknowledgement!.reason}`,
            () => repo.claimResult(r.event.eventId), () => repo.resultDelivered(r.event.eventId), () => repo.resultRejected(r.event.eventId));
        } catch (error) { repo.deliveryError(d.id, definiteDiscordRejection(error) ? 'failed' : 'unknown', String(error)); }
      }
      for (const c of repo.conversationDeliveries()) {
        if (input.stopped()) break;
        const d = repo.byId(c.dialogueId);
        if (!d || !repo.deliveryReady(d.id)) continue;
        try {
          const thread = await threadById(d.threadId);
          await postOnce(thread, `sprint-conversation:${c.id}`, c.output, () => repo.claimConversationDelivery(c.id), () => repo.conversationDelivered(c.id), () => repo.conversationRejected(c.id));
        } catch (error) { repo.deliveryError(d.id, definiteDiscordRejection(error) ? 'failed' : 'unknown', String(error)); }
      }
    } catch (error) { if (!input.stopped()) input.log.warn(`sprint dialogue delivery failed: ${String(error)}`); }
    finally { busy = false; }
  };
}
