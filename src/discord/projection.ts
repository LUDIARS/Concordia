import type { ConcordiaEvent } from "../events.js";

export function eventSessionId(event: ConcordiaEvent): string | null {
  switch (event.type) {
    case "session.started":
    case "session.lost":
    case "session.ended":
    case "session.event":
    case "session.task_changed":
      return event.session_id;
    case "transcript.frame":
    case "session.inject":
    case "session.permission_request":
    case "delegation.mirror":
    case "question.posted":
    case "question.resolved":
    case "operational.claim.opened":
    case "operational.claim.released":
      return event.target_session_id;
    case "chat.posted":
      return event.session_id ?? null;
    default:
      return null;
  }
}
