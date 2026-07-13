import type { PrRecordRow, PrRecordsRepo } from "../db/pr-records-repo.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { ConfirmIntakeDeps } from "../release/confirm-intake.js";
import { intakeDevelopMerge } from "../release/confirm-intake.js";
import { eventBus } from "../events.js";
import { notifyUserDecision } from "./notify.js";

export type GoalMachineOutcome = "merged" | "open" | "missing";

export function findSessionPr(input: { sessionId: string; sessions: SessionsRepo; prs: PrRecordsRepo }): PrRecordRow | null {
  const authored = input.prs.list({ author_session_id: input.sessionId, limit: 20 });
  if (authored.length > 0) return authored[0]!;
  const session = input.sessions.findSession(input.sessionId);
  if (!session?.repo_origin) return null;
  return input.prs.list({ repo_origin: session.repo_origin, limit: 100 })
    .find((pr) => !!session.branch && pr.head_branch === session.branch) ?? null;
}

export async function runGoalMachine(input: {
  sessionId: string;
  sessions: SessionsRepo;
  prs: PrRecordsRepo;
  confirm: ConfirmIntakeDeps;
  mentionUserId?: string | null;
}): Promise<GoalMachineOutcome> {
  const pr = findSessionPr(input);
  if (!pr) {
    notifyUserDecision({ kind: "pr-decision", targetSessionId: input.sessionId, mentionUserId: input.mentionUserId, text: "実装完了を検知しましたが PR が見つかりません。PR 化するか、この作業を閉じるか判断してください。" });
    return "missing";
  }
  if (pr.state === "open" || pr.state === "draft") return "open";
  if (pr.state !== "merged") {
    notifyUserDecision({ kind: "pr-decision", targetSessionId: input.sessionId, mentionUserId: input.mentionUserId, text: `PR #${pr.number} は ${pr.state} です。再開するか閉じるか判断してください。` });
    return "missing";
  }
  const result = await intakeDevelopMerge(input.confirm, {
    repo_origin: pr.repo_origin,
    pr_number: pr.number,
    pr_title: pr.title,
    pr_url: pr.url,
  });
  if (result.created) {
    notifyUserDecision({
      kind: "confirm-queued",
      targetSessionId: input.sessionId,
      mentionUserId: input.mentionUserId,
      text: `確認テストがキューに入りました。/confirm start ${result.row.service_code ?? result.row.repo_name} で開始してください。`,
    });
  }
  eventBus.emit({ type: "taskflow.completion_detected", session_id: input.sessionId, pr_number: pr.number, outcome: "merged", ts: Math.floor(Date.now() / 1000) });
  return "merged";
}
