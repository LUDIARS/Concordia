import type { SessionsRepo } from "../db/sessions-repo.js";
import type { Dispatcher } from "../dispatcher.js";
import { eventBus } from "../events.js";

export interface SessionLostDispatcherDeps {
  sessions: Pick<SessionsRepo, "findSession">;
  dispatcher: Pick<Dispatcher, "onSessionLost">;
}

export function subscribeSessionLostDispatcher(deps: SessionLostDispatcherDeps): () => void {
  return eventBus.subscribe((ev) => {
    if (ev.type !== "session.lost") return;
    const lost = deps.sessions.findSession(ev.session_id);
    if (lost) deps.dispatcher.onSessionLost(lost);
  });
}
