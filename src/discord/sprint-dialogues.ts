import type { Guild } from "discord.js";
import type { Database } from "better-sqlite3";
import { SprintDialoguesRepository } from "../sprint-dialogues/repository.js";
import { sprintConversationQueue, type SprintReply } from "../sprint-dialogues/conversation.js";
import { readSprintActioOrigin } from "../sprint-dialogues/actio-origin.js";
import { sprintDialogueInput } from "./sprint-dialogues-input.js";
import { sprintDelivery } from "./sprint-dialogues-delivery.js";

/** Owned by the head-office Discord runtime; no resources are created until a projection is pending. */
export function startSprintDialogues(input: { guild: Guild; db: Database; parentId: string; workspaceRoot: string;
  allowed?: (userId: string) => boolean; reply: SprintReply; log: { warn(message: string): void } }) {
  const repo = new SprintDialoguesRepository(input.db);
  const abort = new AbortController();
  const stopped = () => abort.signal.aborted;
  let cachedOrigin: { origin: string; at: number } | null = null;
  const origin = async () => {
    if (!cachedOrigin || cachedOrigin.at < Date.now() - 60000) cachedOrigin = { origin: await readSprintActioOrigin(input.workspaceRoot), at: Date.now() };
    return cachedOrigin.origin;
  };
  const deliver = sprintDelivery({ ...input, repo, stopped, origin });
  const converse = sprintConversationQueue(repo, input.reply, abort.signal);
  const timer = setInterval(() => {
    void deliver();
    void converse().catch(error => input.log.warn(`sprint conversation failed: ${String(error)}`));
  }, 3000);
  timer.unref();
  return { ...sprintDialogueInput({ repo, guildId: input.guild.id, botId: input.guild.client.user.id, allowed: input.allowed, stopped }),
    stop: () => { clearInterval(timer); abort.abort(); } };
}
export type SprintDialoguesDiscord = ReturnType<typeof startSprintDialogues>;
