import type { SessionsRepo } from "../db/sessions-repo.js";
import { readGoalAndGoStatus } from "../control/goal-and-go.js";
import { eventBus } from "../events.js";
import type { TaskMdStore } from "./md-store.js";
import { notifyUserDecision } from "./notify.js";
import { DECOMPOSE_PROMPT } from "./decompose-inject.js";
import { allowAutoInject, type PendingQuestionProbe } from "../control/pending-question-blocker.js";

export const RESIDUAL_DOMAIN = "concordia.workflow.residual";
export type ResidualOutcome = "next-task" | "decompose" | "none";

export async function checkResidual(input: {
  sessionId: string;
  sessions: SessionsRepo;
  store: TaskMdStore;
  mentionUserId?: string | null;
  /** 未回答の質問があるセッションには分解プロンプトを送らない (blocker)。 */
  hasPendingQuestion?: PendingQuestionProbe;
}): Promise<ResidualOutcome> {
  const session = input.sessions.findSession(input.sessionId);
  if (!session) return "none";
  const tasks = await input.store.findForProject(session.repo_path, ["pending"]);
  if (tasks.length > 0) {
    const task = tasks[0]!;
    const text = `次タスク: ${task.title} (${input.store.relativePath(task)})`;
    if (readGoalAndGoStatus(session.metadata).enabled) {
      eventBus.emit({ type: "taskflow.continue_requested", target_session_id: input.sessionId, text, ts: Math.floor(Date.now() / 1000) });
    } else {
      notifyUserDecision({ kind: "question", targetSessionId: input.sessionId, mentionUserId: input.mentionUserId, text: `${text}。goal-and-go が無効なため、自走せず待機しています。` });
    }
    eventBus.emit({ type: "taskflow.residual_checked", session_id: input.sessionId, outcome: "next-task", pending_count: tasks.length, ts: Math.floor(Date.now() / 1000) });
    return "next-task";
  }
  const active = await input.store.findForProject(session.repo_path, ["delegated"]);
  if (active.length === 0) {
    // 回答待ちの間は分解プロンプトを送らない。残作業の判定自体 (decompose) は事実なので
    // そのまま返し、次の周回で回答済みになっていれば送られる。
    if (allowAutoInject({ probe: input.hasPendingQuestion, sessionId: input.sessionId, source: "taskflow:residual:decompose" })) {
      input.sessions.appendEvent({ session_id: input.sessionId, ts: Math.floor(Date.now() / 1000), kind: "inject", payload: { text: DECOMPOSE_PROMPT, source: "taskflow:residual:decompose" } });
      eventBus.emit({ type: "session.inject", target_session_id: input.sessionId, text: DECOMPOSE_PROMPT, source: "taskflow:residual:decompose", ts: Math.floor(Date.now() / 1000) });
    }
    eventBus.emit({ type: "taskflow.residual_checked", session_id: input.sessionId, outcome: "decompose", pending_count: 0, ts: Math.floor(Date.now() / 1000) });
    return "decompose";
  }
  eventBus.emit({ type: "taskflow.residual_checked", session_id: input.sessionId, outcome: "none", pending_count: 0, ts: Math.floor(Date.now() / 1000) });
  return "none";
}
