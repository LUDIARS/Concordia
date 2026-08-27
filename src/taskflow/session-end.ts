import type { SessionsRepo } from "../db/sessions-repo.js";
import type { DelegationRunRow } from "../db/delegation-repo.js";
import type { GoalMachineOutcome } from "./goal-machine.js";
import type { ResidualOutcome } from "./residual-blackbox.js";
import { allowAutoInject, type PendingQuestionProbe } from "../control/pending-question-blocker.js";
import { AUTO_SESSION_END_INJECT_SOURCE } from "../control/auto-session-end-inject.js";
import { scheduleTeardownLadder } from "./teardown-ladder.js";

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
  /** TaskWorkflow の正本となる delegation run。一般セッションは終了対象にしない。 */
  taskflowRun: Pick<DelegationRunRow, "id" | "child_session_id">;
  goalOutcome: GoalMachineOutcome;
  residualOutcome: ResidualOutcome;
  nowSec?: () => number;
  /** 未回答の質問があるセッションには終了 ladder を予約しない (blocker)。 */
  hasPendingQuestion?: PendingQuestionProbe;
}): boolean {
  if (input.taskflowRun.child_session_id !== input.sessionId) return false;
  const session = input.sessions.findSession(input.sessionId);
  if (!session || !shouldEndAutonomousTaskflow({
    goalOutcome: input.goalOutcome,
    residualOutcome: input.residualOutcome,
  })) return false;
  const runKey = `delegation:${input.taskflowRun.id}`;
  // 終了判断とは別の未回答質問があるなら、その回答を捨てる即時 teardown はしない。
  // 回答後の次周回で同じ確定済みゴールを再評価し、ladder を予約する。
  if (!allowAutoInject({
    probe: input.hasPendingQuestion,
    sessionId: input.sessionId,
    source: AUTO_SESSION_END_INJECT_SOURCE,
  })) return false;
  const ts = (input.nowSec ?? (() => Math.floor(Date.now() / 1000)))();
  return scheduleTeardownLadder(input.sessions, session, runKey, ts);
}
