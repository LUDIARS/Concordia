import type { SessionsRepo } from "../db/sessions-repo.js";
import type { GoalMachineOutcome } from "./goal-machine.js";
import type { ResidualOutcome } from "./residual-blackbox.js";
import { readGoalAndGoStatus } from "../control/goal-and-go.js";
import {
  AUTO_SESSION_END_INJECT_SOURCE,
  emitAutoSessionEndInject,
  pickSessionEndInjectText,
} from "../control/auto-session-end-inject.js";

function hasRecordedSessionEnd(sessions: SessionsRepo, sessionId: string): boolean {
  return sessions.recentEvents(sessionId, 200).some((event) => {
    if (event.kind !== "inject") return false;
    try {
      const payload = JSON.parse(event.payload) as { source?: unknown };
      return payload.source === AUTO_SESSION_END_INJECT_SOURCE;
    } catch {
      return false;
    }
  });
}

export function shouldEndAutonomousTaskflow(input: {
  goalOutcome: GoalMachineOutcome;
  residualOutcome: ResidualOutcome;
  goalAndGoEnabled: boolean;
}): boolean {
  return input.goalAndGoEnabled
    && input.goalOutcome === "open"
    && input.residualOutcome === "none";
}

export function finishAutonomousTaskflow(input: {
  sessionId: string;
  sessions: SessionsRepo;
  goalOutcome: GoalMachineOutcome;
  residualOutcome: ResidualOutcome;
  nowSec?: () => number;
}): boolean {
  const session = input.sessions.findSession(input.sessionId);
  if (!session || !shouldEndAutonomousTaskflow({
    goalOutcome: input.goalOutcome,
    residualOutcome: input.residualOutcome,
    goalAndGoEnabled: readGoalAndGoStatus(session.metadata).enabled,
  })) return false;
  if (hasRecordedSessionEnd(input.sessions, input.sessionId)) return false;

  const text = pickSessionEndInjectText(session.provider);
  input.sessions.appendEvent({
    session_id: input.sessionId,
    ts: (input.nowSec ?? (() => Math.floor(Date.now() / 1000)))(),
    kind: "inject",
    payload: { text, source: AUTO_SESSION_END_INJECT_SOURCE },
  });
  return emitAutoSessionEndInject(session);
}
