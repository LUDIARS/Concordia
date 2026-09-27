import { ChannelType, type Guild } from "discord.js";
import type { DiscordSessionChannelsRepo } from "../db/discord-repo.js";
import { readTaskWorkflowStarter, shouldArchiveTaskWorkflowOrphan, TASKWORKFLOW_ORPHAN_GRACE_MS } from "./taskworkflow-orphan-policy.js";

interface TaskWorkflowOrphanDeps {
  guild: Guild;
  forumId: string;
  bindings: Pick<DiscordSessionChannelsRepo, "findByChannelId" | "findBySessionId">;
  findSession: (id: string) => { status: string } | null;
  findRun: (id: string) => { child_session_id: string | null } | null;
  log: { info: (message: string) => void; warn: (message: string) => void };
  dryRun: () => boolean;
  now?: () => number;
}

/**
 * Reverse lookup repairs threads that DB-only reconciliation cannot see.
 * @implements spec/feature/taskworkflow-orphan-reconciliation.md CC-DISCORD-TASK-ORPHAN-01
 */
export function createTaskWorkflowOrphanReconciler(deps: TaskWorkflowOrphanDeps): () => Promise<void> {
  let cursor = "";
  let active: Promise<void> | null = null;
  const now = deps.now ?? Date.now;

  async function reconcile(): Promise<void> {
    if (!deps.forumId || !deps.guild.client.user) return;
    const forum = await deps.guild.channels.fetch(deps.forumId);
    if (forum?.type !== ChannelType.GuildForum) return;
    const botId = deps.guild.client.user.id;
    const { threads } = await deps.guild.channels.fetchActiveThreads();
    const candidates = [...threads.values()].filter((thread) =>
      thread.type === ChannelType.PublicThread && thread.parentId === forum.id && !thread.archived
      && thread.createdTimestamp !== null && now() - thread.createdTimestamp >= TASKWORKFLOW_ORPHAN_GRACE_MS
      && !deps.bindings.findByChannelId(thread.id),
    ).sort((a, b) => a.id.localeCompare(b.id));
    if (!candidates.length) return;
    const start = candidates.findIndex((thread) => thread.id > cursor);
    const offset = start < 0 ? 0 : start;
    const batch = [...candidates.slice(offset), ...candidates.slice(0, offset)].slice(0, 25);
    const hooks = await forum.fetchWebhooks();
    const ownedHooks = new Set([...hooks.values()].filter((hook) => hook.owner?.id === botId).map((hook) => hook.id));
    for (const thread of batch) {
      cursor = thread.id;
      try {
        const starter = await thread.fetchStarterMessage();
        if (!starter || starter.id !== thread.id) continue;
        const trustedStarter = starter.webhookId
          ? ownedHooks.has(starter.webhookId)
          : starter.author.id === botId;
        const identity = readTaskWorkflowStarter(starter.content);
        if (!identity || !trustedStarter) continue;
        // The awaited Discord reads can race a new binding/session. Re-read owners last.
        const archive = shouldArchiveTaskWorkflowOrphan({
          trustedStarter,
          identity,
          runChildSessionId: deps.findRun(identity.runId)?.child_session_id ?? null,
          sessionStatus: deps.findSession(identity.sessionId)?.status ?? null,
          hasChannelBinding: Boolean(deps.bindings.findByChannelId(thread.id)),
          hasSessionBinding: Boolean(deps.bindings.findBySessionId(identity.sessionId)),
          createdAtMs: thread.createdTimestamp,
          nowMs: now(),
        });
        if (!archive) continue;
        if (deps.dryRun()) {
          deps.log.info(`taskworkflow-orphan: dry-run candidate thread=${thread.id}`);
          continue;
        }
        await thread.setArchived(true, "Concordia TaskWorkflow orphan: no binding or active session");
        deps.log.info(`taskworkflow-orphan: archived thread=${thread.id}`);
      } catch (error) {
        deps.log.warn(`taskworkflow-orphan: thread=${thread.id} failed: ${(error as Error).message}`);
      }
    }
  }

  return () => {
    if (active) return active;
    const pending = Promise.resolve().then(reconcile).catch((error) => {
      deps.log.warn(`taskworkflow-orphan: scan failed: ${(error as Error).message}`);
    }).finally(() => { active = null; });
    active = pending;
    return pending;
  };
}
