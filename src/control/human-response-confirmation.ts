/** @implements spec/feature/human-response-confirmation.md */
import type { SessionsRepo } from "../db/sessions-repo.js";
import { eventBus, type ConcordiaEvent } from "../events.js";
import { parseRequesterSource } from "./requester.js";

type ConfirmationSessions = Pick<SessionsRepo, "findSession" | "mergeMetadata">;
const KEY = "human_response_confirmation";

/** Only provenance-bearing human input can reopen a confirmation cycle. */
export function humanResponseSession(event: ConcordiaEvent): string | null {
  if (event.type === "question.answered") return event.target_session_id;
  if (event.type === "session.event" && event.kind === "user_activity") return event.session_id;
  if (event.type === "session.inject"
    && (parseRequesterSource(event.source) || event.provenance?.actorId?.trim())) {
    return event.target_session_id;
  }
  // Injected prompts also appear as user transcript frames. Neither their echo nor an
  // assistant acknowledgement proves that the person has responded.
  return null;
}

function isWaiting(metadata: string | null): boolean {
  if (!metadata) return false;
  // Callers include the stalled-session sweep, which walks every active session in one
  // pass. A single unparseable metadata blob must not abort the sweep for the rest.
  let value: unknown;
  try {
    value = JSON.parse(metadata);
  } catch {
    return false;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return (value as Record<string, unknown>)[KEY] === true;
}

export function isWaitingForHumanResponse(repo: ConfirmationSessions, sessionId: string): boolean {
  const session = repo.findSession(sessionId);
  return session ? isWaiting(session.metadata) : false;
}

/** Claim synchronously before emitting or awaiting: reentrant replies cannot send twice. */
export function claimHumanResponseConfirmation(repo: ConfirmationSessions, sessionId: string): boolean {
  const session = repo.findSession(sessionId);
  if (!session || session.status !== "active" || isWaiting(session.metadata)) return false;
  repo.mergeMetadata(sessionId, { [KEY]: true });
  return true;
}

export function startHumanResponseConfirmation(repo: ConfirmationSessions): { stop(): void } {
  const unsubscribe = eventBus.subscribe((event) => {
    const sessionId = humanResponseSession(event);
    if (!sessionId) return;
    const session = repo.findSession(sessionId);
    if (!session || !isWaiting(session.metadata)) return;
    repo.mergeMetadata(sessionId, { [KEY]: false });
  });
  return { stop: unsubscribe };
}
