import type { Guild } from "discord.js";
import type { DiscordSessionChannelsRepo } from "../db/discord-repo.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import { eventBus, type ConcordiaEvent } from "../events.js";
import { readSessionWorkPhase } from "../work/session-work-phase.js";
import { fetchForumSessionThread } from "./forum-session.js";
import { withForumWorkPhase } from "./forum-title.js";

const RECONCILE_MS = 60_000;
const PHASE_EVENTS = new Set(["work_phase_changed", "branch_changed", "lictor.active_repo.changed", "task_update", "title_renamed"]);

function affectedSession(event: ConcordiaEvent): string | null {
  if (event.type === "session.started" || event.type === "session.task_changed") return event.session_id;
  return event.type === "session.event" && PHASE_EVENTS.has(event.kind) ? event.session_id : null;
}

/** Projects persisted phase onto existing names; never changes business state or locked summaries. */
export function startForumPhaseTitleSync(deps: {
  guild: Guild;
  channels: Pick<DiscordSessionChannelsRepo, "findBySessionId" | "listAll">;
  sessions: Pick<SessionsRepo, "findSession">;
  ownsSession: (sessionId: string) => boolean;
  log: { warn: (message: string) => void };
}): { refresh(sessionId: string): Promise<void>; reconcile(): Promise<void>; stop(): void } {
  let stopped = false;
  let running: Promise<void> | null = null;
  const pending = new Set<string>();
  const eligible = (id: string): boolean => {
    const channel = deps.channels.findBySessionId(id);
    return deps.ownsSession(id) && channel?.channel_kind === "thread" && channel.status === "active"
      && deps.sessions.findSession(id)?.status === "active";
  };
  const drain = (): Promise<void> => {
    if (running) return running;
    // Defer execution until running is assigned, including an empty initial scan.
    running = Promise.resolve().then(async () => {
      while (!stopped && pending.size > 0) {
        const id = pending.values().next().value!;
        pending.delete(id);
        try {
          if (!eligible(id)) continue;
          const channelId = deps.channels.findBySessionId(id)!.channel_id;
          const thread = await fetchForumSessionThread(deps.guild, channelId);
          if (stopped || !thread || thread.archived || !eligible(id)
            || deps.channels.findBySessionId(id)?.channel_id !== channelId) continue;
          // Read the latest scoped phase after the asynchronous fetch, never the event payload.
          const session = deps.sessions.findSession(id)!;
          const name = withForumWorkPhase(thread.name, readSessionWorkPhase(session).phase);
          if (name !== thread.name) await thread.setName(name, "Concordia work phase updated");
        } catch {
          // Do not record delivery success. The periodic pass retries from current state.
          deps.log.warn("session-forum: work phase title update failed; retry on reconciliation");
        }
      }
    }).finally(() => { running = null; });
    return running;
  };
  const refresh = (id: string): Promise<void> => {
    if (stopped || !eligible(id)) return Promise.resolve();
    pending.add(id);
    return drain();
  };
  const reconcile = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    for (const row of deps.channels.listAll()) {
      if (eligible(row.session_id)) pending.add(row.session_id);
    }
    return drain();
  };
  const unsubscribe = eventBus.subscribe((event) => {
    const id = affectedSession(event);
    if (id) void refresh(id);
  });
  const timer = setInterval(() => { void reconcile(); }, RECONCILE_MS);
  timer.unref?.();
  void reconcile();
  return { refresh, reconcile, stop: () => {
    stopped = true;
    clearInterval(timer);
    unsubscribe();
    pending.clear();
  } };
}
