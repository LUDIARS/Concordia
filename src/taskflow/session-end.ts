import type { SessionsRepo } from "../db/sessions-repo.js";
import type { GoalMachineOutcome } from "./goal-machine.js";
import type { ResidualOutcome } from "./residual-blackbox.js";
import { readGoalAndGoStatus } from "../control/goal-and-go.js";
import { eventBus } from "../events.js";
import { allowAutoInject, type PendingQuestionProbe } from "../control/pending-question-blocker.js";

const INQUIRY_INJECT_SOURCE = "auto:inquiry";
const PART_TIMER_CATEGORY = "パートタイマー";

/**
 * 二重送信の抑止。 category まで見るのは、 作業完了時の自動お伺い (category=タスク,
 * src/api/inquiry.ts) が同じ source で inject を積むため。 source だけで判定すると
 * タスク お伺いが 1 回でも走ったセッションで完了報告が永久に出なくなる。
 */
function hasRecordedInquiry(sessions: SessionsRepo, sessionId: string, runKey: string): boolean {
  return sessions.recentEvents(sessionId, 200).some((event) => {
    if (event.kind !== "inject") return false;
    try {
      const payload = JSON.parse(event.payload) as { source?: unknown; category?: unknown; run_key?: unknown };
      return payload.source === INQUIRY_INJECT_SOURCE
        && payload.category === PART_TIMER_CATEGORY
        && payload.run_key === runKey;
    } catch {
      return false;
    }
  });
}

export function shouldEndAutonomousTaskflow(input: {
  goalOutcome: GoalMachineOutcome;
  residualOutcome: ResidualOutcome;
}): boolean {
  return input.goalOutcome === "open"
    && input.residualOutcome === "none";
}

export function finishAutonomousTaskflow(input: {
  sessionId: string;
  sessions: SessionsRepo;
  goalOutcome: GoalMachineOutcome;
  residualOutcome: ResidualOutcome;
  nowSec?: () => number;
  /** 未回答の質問があるセッションには完了お伺いを送らない (blocker)。 */
  hasPendingQuestion?: PendingQuestionProbe;
}): boolean {
  const session = input.sessions.findSession(input.sessionId);
  if (!session || !shouldEndAutonomousTaskflow({
    goalOutcome: input.goalOutcome,
    residualOutcome: input.residualOutcome,
  })) return false;
  const goalAndGo = readGoalAndGoStatus(session.metadata);
  // current_task changes at a task boundary. continuation_count distinguishes repeated
  // one-shot runs whose task title is intentionally unchanged.
  const runKey = `${session.current_task ?? "(unassigned)"}:${goalAndGo.continuation_count}`;
  if (hasRecordedInquiry(input.sessions, input.sessionId, runKey)) return false;
  // 回答待ちの間は完了お伺いを送らない (記録も残さないので、回答後に改めて送られる)。
  if (!allowAutoInject({
    probe: input.hasPendingQuestion,
    sessionId: input.sessionId,
    source: INQUIRY_INJECT_SOURCE,
  })) return false;

  const text = "作業完了のお伺いです。残タスクを確認し、残タスクが無ければ session-end を実行してください。これはお伺い応答に基づく確定指示です。";
  // 記録と emit で ts がずれないよう 1 回だけ読む。
  const ts = (input.nowSec ?? (() => Math.floor(Date.now() / 1000)))();
  input.sessions.appendEvent({
    session_id: input.sessionId,
    ts,
    kind: "inject",
    payload: { text, source: INQUIRY_INJECT_SOURCE, category: PART_TIMER_CATEGORY, run_key: runKey },
  });
  eventBus.emit({
    type: "session.inject",
    target_session_id: input.sessionId,
    text,
    source: INQUIRY_INJECT_SOURCE,
    ts,
  });
  return true;
}
