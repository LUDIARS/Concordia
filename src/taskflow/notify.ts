import { eventBus } from "../events.js";

export type UserDecisionKind = "confirm-queued" | "no-tasks" | "pr-decision" | "impl-unlock" | "question";

export function notifyUserDecision(input: {
  kind: UserDecisionKind;
  text: string;
  targetSessionId: string;
  mentionUserId?: string | null;
}): void {
  eventBus.emit({
    type: "taskflow.user_decision",
    kind: input.kind,
    target_session_id: input.targetSessionId,
    text: input.text,
    mention_user_id: input.mentionUserId ?? null,
    ts: Math.floor(Date.now() / 1000),
  });
}
