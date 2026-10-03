import type { SessionsRepo } from "../db/sessions-repo.js";
import { readGoalAndGoStatus } from "../control/goal-and-go.js";
import { eventBus } from "../events.js";
import type { TaskStore } from "./store.js";
import { notifyUserDecision } from "./notify.js";
import { DECOMPOSE_PROMPT } from "./decompose-inject.js";
import { allowAutoInject, type PendingQuestionProbe } from "../control/pending-question-blocker.js";
import { claimHumanResponseConfirmation, isWaitingForHumanResponse } from "../control/human-response-confirmation.js";
import { readHumanWait } from "../control/human-wait.js";
import { readSubsidiaryId } from "../shared/subsidiary-id.js";
import { readResidentMarker } from "../delegation/sidecar/lifecycle-policy.js";
import { matchesResidualBinding, residualBinding } from "./residual-binding.js";

export const RESIDUAL_DOMAIN = "concordia.workflow.residual";
export type ResidualOutcome = "next-task" | "decompose" | "none" | "waiting";

export async function checkResidual(input: {
  sessionId: string;
  sessions: SessionsRepo;
  store: TaskStore;
  mentionUserId?: string | null;
  /** 未回答の質問があるセッションには分解プロンプトを送らない (blocker)。 */
  hasPendingQuestion?: PendingQuestionProbe;
}): Promise<ResidualOutcome> {
  const session = input.sessions.findSession(input.sessionId);
  if (!session) return "none";
  if(readResidentMarker(session.metadata)) return "none"; // Await the owner's next request, not a new autonomous assignment.
  const binding = residualBinding(session);
  const readySession = () => {
    const latest = input.sessions.findSession(input.sessionId);
    if (!matchesResidualBinding(binding,latest) || !latest || readResidentMarker(latest.metadata)
      || readHumanWait(latest.metadata) || isWaitingForHumanResponse(input.sessions,input.sessionId)) return null;
    if (!allowAutoInject({probe:input.hasPendingQuestion,sessionId:input.sessionId,source:"taskflow:residual:next"})) return null;
    // Legacy true also denotes an explicit wait; never interpret it as approval.
    try { if (JSON.parse(latest.metadata ?? "{}").cc_human_wait === true) return null; }
    catch { return null; }
    return latest;
  };
  if (!readySession()) return "waiting";
  if (!allowAutoInject({ probe: input.hasPendingQuestion, sessionId: input.sessionId, source: "taskflow:residual:next" })) return "waiting";
  const tasks = await input.store.findForProject(session.repo_path, ["pending"], readSubsidiaryId(session.metadata));
  if (!readySession()) return "waiting";
  if (tasks.length > 0) {
    const task = input.store.nextExecutable
      ? await input.store.nextExecutable(session.repo_path, readSubsidiaryId(session.metadata)) : tasks[0]!;
    if (!task) return "waiting";
    const latest = readySession();
    if (!latest || !allowAutoInject({probe:input.hasPendingQuestion,sessionId:input.sessionId,source:"taskflow:residual:next"})) return "waiting";
    const text = `次タスクを Actio から取得してください (${input.store.relativePath(task)})`;
    const confirmation = {type:"session.inject",target_session_id:input.sessionId,text,
      source:"taskflow:residual:question",ts:Math.floor(Date.now()/1000)} as const;
    if (!eventBus.canDeliverInject(confirmation)) return "waiting";
    if (readGoalAndGoStatus(latest.metadata).enabled) {
      eventBus.emit({ type: "taskflow.continue_requested", target_session_id: input.sessionId, text, ts: Math.floor(Date.now() / 1000) });
    } else {
      if (!allowAutoInject({ probe: input.hasPendingQuestion, sessionId: input.sessionId, source: "taskflow:residual:question" })
        || !claimHumanResponseConfirmation(input.sessions, input.sessionId)) return "waiting";
      notifyUserDecision({ kind: "question", targetSessionId: input.sessionId, mentionUserId: input.mentionUserId, text: `${text}。goal-and-go が無効なため、自走せず待機しています。` });
    }
    eventBus.emit({ type: "taskflow.residual_checked", session_id: input.sessionId, outcome: "next-task", pending_count: tasks.length, ts: Math.floor(Date.now() / 1000) });
    return "next-task";
  }
  const active = await input.store.findForProject(session.repo_path, ["delegated"], readSubsidiaryId(session.metadata));
  if (!readySession()) return "waiting";
  if (active.length === 0) {
    // Do not emit residual_checked when suppressed: phase-compaction would otherwise
    // inject another prompt and turn the assistant's waiting reply into a new cycle.
    const source="taskflow:residual:decompose:human-confirmation";
    const event={type:"session.inject",target_session_id:input.sessionId,text:DECOMPOSE_PROMPT,source,ts:Math.floor(Date.now()/1000)} as const;
    if (!eventBus.canDeliverInject(event) || !readySession()
      || !allowAutoInject({ probe: input.hasPendingQuestion, sessionId: input.sessionId, source })
      || !claimHumanResponseConfirmation(input.sessions, input.sessionId)) return "waiting";
    // This is the newly claimed confirmation request, not work resumption.
    input.sessions.appendEvent({ session_id: input.sessionId, ts:event.ts, kind: "inject", payload: { text: DECOMPOSE_PROMPT, source } });
    eventBus.emit(event);
    eventBus.emit({ type: "taskflow.residual_checked", session_id: input.sessionId, outcome: "decompose", pending_count: 0, ts: Math.floor(Date.now() / 1000) });
    return "decompose";
  }
  eventBus.emit({ type: "taskflow.residual_checked", session_id: input.sessionId, outcome: "none", pending_count: 0, ts: Math.floor(Date.now() / 1000) });
  return "none";
}
