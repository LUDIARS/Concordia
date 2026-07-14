import type { SessionsRepo } from "../db/sessions-repo.js";
import { readGoalAndGoStatus } from "../control/goal-and-go.js";
import { eventBus } from "../events.js";
import type { TaskMdStore } from "./md-store.js";
import { notifyUserDecision } from "./notify.js";
import { DECOMPOSE_PROMPT } from "./decompose-inject.js";

export const RESIDUAL_DOMAIN = "concordia.workflow.residual";

export async function checkResidual(input: {
  sessionId: string;
  sessions: SessionsRepo;
  store: TaskMdStore;
  mentionUserId?: string | null;
}): Promise<"next-task" | "decompose" | "none"> {
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
    input.sessions.appendEvent({ session_id: input.sessionId, ts: Math.floor(Date.now() / 1000), kind: "inject", payload: { text: DECOMPOSE_PROMPT, source: "taskflow:residual:decompose" } });
    eventBus.emit({ type: "session.inject", target_session_id: input.sessionId, text: DECOMPOSE_PROMPT, source: "taskflow:residual:decompose", ts: Math.floor(Date.now() / 1000) });
    eventBus.emit({ type: "taskflow.residual_checked", session_id: input.sessionId, outcome: "decompose", pending_count: 0, ts: Math.floor(Date.now() / 1000) });
    return "decompose";
  }
  notifyUserDecision({ kind: "no-tasks", targetSessionId: input.sessionId, mentionUserId: input.mentionUserId, text: "残作業タスクがありません。ワークフローを閉じてよいか確認してください。" });
  eventBus.emit({ type: "taskflow.residual_checked", session_id: input.sessionId, outcome: "none", pending_count: 0, ts: Math.floor(Date.now() / 1000) });
  return "none";
}
