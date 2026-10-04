/**
 * Reflect observed current_task changes through existing title events.
 * Observation must not enqueue automatic title-suggest work for Lictor.
 * @implements CC-AUTO-TITLE-TASK-STOP AT-01 AT-02
 */
import type { SessionsRepo } from "../db/sessions-repo.js";
import { eventBus, type ConcordiaEvent } from "../events.js";
import { createChildLogger } from "../shared/logger.js";

const log = createChildLogger("title-watcher");
export interface RepoChangeWatcherDeps { sessions: SessionsRepo }
export interface RepoChangeWatcherHandle {
  stop: () => void;
  handle: (ev: ConcordiaEvent) => void;
  peekCache: () => { lastRepoPath: Map<string, string> };
}

export function startRepoChangeWatcher(deps: RepoChangeWatcherDeps): RepoChangeWatcherHandle {
  const lastRepoPath = new Map<string, string>();
  const lastTitle = new Map<string, string>();
  function handle(ev: ConcordiaEvent): void {
    if (ev.type !== "stat.collected") return;
    const session = deps.sessions.findSession(ev.session_id);
    if (!session) return;
    lastRepoPath.set(session.id, session.repo_path);
    const title = (session.current_task ?? "").trim();
    if (!title || lastTitle.get(session.id) === title) return;
    lastTitle.set(session.id, title);
    const ts = Math.floor(Date.now() / 1000);
    deps.sessions.appendEvent({ session_id: session.id, ts, kind: "title_renamed", payload: { text: title } });
    eventBus.emit({ type: "session.event", session_id: session.id, kind: "title_renamed", ts });
    log.info({ session_id: session.id, task: title.slice(0, 40) }, "current_task changed — channel rename emitted");
  }
  const unsub = eventBus.subscribe(handle);
  return {
    stop: () => unsub(),
    handle,
    peekCache: () => ({ lastRepoPath: new Map(lastRepoPath) }),
  };
}
