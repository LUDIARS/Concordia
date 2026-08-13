import type { SessionsRepo } from "../db/sessions-repo.js";
import { eventBus } from "../events.js";

type InstructionSessions = Pick<SessionsRepo, "appendEvent">;

/** Persist a Director instruction before attempting live WS delivery. */
export function deliverDirectorInstruction(input: {
  sessions: InstructionSessions;
  sessionId: string;
  text: string;
  source: string;
  ts?: number;
}): void {
  const ts = input.ts ?? Math.floor(Date.now() / 1000);
  input.sessions.appendEvent({
    session_id: input.sessionId,
    ts,
    kind: "inject",
    payload: { text: input.text, source: input.source },
  });
  eventBus.emit({
    type: "session.inject",
    target_session_id: input.sessionId,
    text: input.text,
    source: input.source,
    ts,
  });
}
