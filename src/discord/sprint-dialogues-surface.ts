import { ChannelType, type Guild, type ForumChannel, type ThreadChannel, type Message } from "discord.js";
import type { SprintDialoguesRepository } from "../sprint-dialogues/repository.js";
import type { Dialogue } from "../sprint-dialogues/domain.js";
import { sprintCard } from "./sprint-dialogues-card.js";

const forumMarker = "Concordia sprint dialogues v1";
/** A Discord HTTP rejection proves no resource was created; transport failures do not. */
export function definiteDiscordRejection(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" && status >= 400 && status < 500 && status !== 408;
}
export async function sprintForum(guild: Guild, parentId: string, repo: SprintDialoguesRepository, stopped: () => boolean): Promise<ForumChannel> {
  const saved = repo.surface(guild.id);
  const all = await guild.channels.fetch();
  const candidates = [...all.values()].filter((c): c is ForumChannel => c?.type === ChannelType.GuildForum && c.topic === forumMarker);
  if (candidates.length > 1) throw new Error("スプリントフォーラムが複数あります。管理者による照合が必要です。");
  const known = saved.forumId ? all.get(saved.forumId) : candidates[0];
  if (known?.type === ChannelType.GuildForum && known.topic === forumMarker) { repo.saveForum(guild.id, known.id); return known; }
  if (stopped() || saved.forumId || saved.intent || !repo.claimForum(guild.id)) throw new Error("フォーラム作成結果が不明です。既存のConcordia sprint dialogues v1面を確認してください。");
  try {
    const forum = await guild.channels.create({ type: ChannelType.GuildForum, name: "スプリント", parent: parentId, topic: forumMarker });
    repo.saveForum(guild.id, forum.id);
    return forum;
  } catch (error) { if (definiteDiscordRejection(error)) repo.forumRejected(guild.id); throw error; }
}
async function findThread(forum: ForumChannel, marker: string): Promise<ThreadChannel | null> {
  const active = await forum.threads.fetchActive();
  const found = [...active.threads.values()].filter(t => t.name.endsWith(marker));
  let before: Date | undefined;
  for (let page = 0; page < 20; page++) {
    const archived = await forum.threads.fetchArchived({ limit: 100, ...(before ? { before } : {}) });
    found.push(...[...archived.threads.values()].filter(t => t.name.endsWith(marker)));
    if (!archived.hasMore) {
      const unique = [...new Map(found.map(t => [t.id, t])).values()];
      if (unique.length > 1) throw new Error("スプリントの既存スレッドが複数あります。照合が必要です。");
      return unique[0] ?? null;
    }
    const last = archived.threads.last()?.archiveTimestamp;
    if (!last) break;
    before = new Date(last);
  }
  throw new Error("アーカイブの照合上限を超えました。スレッドを再作成せず確認を待っています。");
}
export async function sprintThread(forum: ForumChannel, dialogue: Dialogue, repo: SprintDialoguesRepository, origin: string, stopped: () => boolean): Promise<ThreadChannel> {
  if (dialogue.threadId) {
    const known = await forum.guild.channels.fetch(dialogue.threadId);
    if (!known?.isThread() || known.parentId !== forum.id) throw new Error("保存済みのスプリントスレッドを確認できません。");
    if (known.archived && !stopped()) await known.setArchived(false);
    return known;
  }
  const marker = `[${dialogue.id}]`;
  const found = await findThread(forum, marker);
  if (found) {
    const starter = await found.fetchStarterMessage();
    if (!starter || starter.webhookId || starter.author.id !== forum.client.user.id || !starter.content.endsWith(`sprint-dialogue:${dialogue.id}`)) throw new Error("既存スレッドの作成者と受付IDを確認できません。");
    repo.saveThread(dialogue.id, forum.guild.id, found.id);
    if (found.archived && !stopped()) await found.setArchived(false);
    return found;
  }
  if (stopped() || dialogue.threadIntent || !repo.claimThread(dialogue.id)) throw new Error("スレッド作成結果が不明です。同じ受付IDのスレッドを確認してください。");
  try {
    const created = await forum.threads.create({ name: `${dialogue.projection.sprintName.slice(0, 65)} ${marker}`,
      message: sprintCard(dialogue, origin) });
    repo.saveThread(dialogue.id, forum.guild.id, created.id);
    return created;
  } catch (error) { if (definiteDiscordRejection(error)) repo.threadRejected(dialogue.id); throw error; }
}
export async function findPosted(thread: ThreadChannel, marker: string): Promise<Message | null> {
  let before: string | undefined;
  for (let page = 0; page < 20; page++) {
    const messages = await thread.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    const found = messages.find(m => !m.webhookId && m.author.id === thread.client.user.id && m.content.endsWith(`\n\n${marker}`));
    if (found) return found;
    if (messages.size < 100) return null;
    before = messages.last()?.id;
  }
  throw new Error("配達履歴の照合上限を超えました。二重配達を防ぐため確認待ちです。");
}
