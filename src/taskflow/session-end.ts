import type { SessionsRepo } from "../db/sessions-repo.js";
import type { GoalMachineOutcome } from "./goal-machine.js";
import type { ResidualOutcome } from "./residual-blackbox.js";
import { readGoalAndGoStatus } from "../control/goal-and-go.js";
import { eventBus } from "../events.js";

const INQUIRY_INJECT_SOURCE = "auto:inquiry";
const PART_TIMER_CATEGORY = "パートタイマー";

/**
 * 二重送信の抑止。 category まで見るのは、 作業完了時の自動お伺い (category=タスク,
 * src/api/inquiry.ts) が同じ source で inject を積むため。 source だけで判定すると
 * タスク お伺いが 1 回でも走ったセッションで完了報告が永久に出なくなる。
 */
function hasRecordedInquiry(sessions: SessionsRepo, sessionId: string): boolean {
  return sessions.recentEvents(sessionId, 200).some((event) => {
    if (event.kind !== "inject") return false;
    try {
      const payload = JSON.parse(event.payload) as { source?: unknown; category?: unknown };
      return payload.source === INQUIRY_INJECT_SOURCE && payload.category === PART_TIMER_CATEGORY;
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
  if (hasRecordedInquiry(input.sessions, input.sessionId)) return false;

  const text = "作業完了のお伺いです。残タスクを確認し、残タスクが無ければ session-end を実行してください。終了は自分で判断してください。";
  // 記録と emit で ts がずれないよう 1 回だけ読む。
  const ts = (input.nowSec ?? (() => Math.floor(Date.now() / 1000)))();
  input.sessions.appendEvent({
    session_id: input.sessionId,
    ts,
    kind: "inject",
    payload: { text, source: INQUIRY_INJECT_SOURCE, category: PART_TIMER_CATEGORY },
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
