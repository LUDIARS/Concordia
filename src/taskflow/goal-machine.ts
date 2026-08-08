import type { PrRecordRow, PrRecordsRepo } from "../db/pr-records-repo.js";
import type { RevisorLocalPr, RevisorLocalPrReader } from "../pr/revisor-client.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { ConfirmIntakeDeps } from "../release/confirm-intake.js";
import { intakeDevelopMerge } from "../release/confirm-intake.js";
import { normalizeRepoOrigin } from "../pr/normalize.js";
import { eventBus } from "../events.js";
import { notifyUserDecision } from "./notify.js";

export type GoalMachineOutcome = "merged" | "open" | "missing";

/**
 * セッションの作業ブランチに対応する Revisor local PR を探す。
 *
 * Revisor 運用では GitHub PR (pr_records) が作られないため、 goal 判断が
 * GitHub だけを見ると常に「PR 無し」になり、 local PR がマージされても
 * confirm キュー投入・残作業チェックが発火しなかった (接続断)。
 * 突合は提出時と同じ規則: repository は owner/repo へ正規化して大小無視、
 * headRef は git と同じく大小区別 (local-pr-submission.ts の plan と揃える)。
 */
export async function findSessionLocalPr(input: {
  sessionId: string;
  sessions: SessionsRepo;
  revisor: RevisorLocalPrReader;
}): Promise<RevisorLocalPr | null> {
  const session = input.sessions.findSession(input.sessionId);
  if (!session?.repo_origin || !session.branch) return null;
  const key = normalizeRepoOrigin(session.repo_origin).toLowerCase();
  let pullRequests: RevisorLocalPr[];
  try {
    pullRequests = await input.revisor.listLocalPrs();
  } catch {
    // Revisor 停止中は判断材料が無い。 誤って missing (PR 無し) 扱いにしない。
    return null;
  }
  return pullRequests.find((pr) =>
    normalizeRepoOrigin(pr.repository).toLowerCase() === key
    && pr.headRef === session.branch) ?? null;
}

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
  /** Revisor local PR の読み取り口。 未注入なら従来どおり GitHub PR のみで判断する。 */
  revisor?: RevisorLocalPrReader;
  mentionUserId?: string | null;
}): Promise<GoalMachineOutcome> {
  const pr = findSessionPr(input);
  if (!pr && input.revisor) {
    const localPr = await findSessionLocalPr({ sessionId: input.sessionId, sessions: input.sessions, revisor: input.revisor });
    if (localPr) return runLocalPrGoal(input, localPr);
  }
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

/** Revisor local PR に基づくゴール判断。 GitHub PR の分岐と同じ意味論で合流させる。 */
async function runLocalPrGoal(
  input: {
    sessionId: string;
    sessions: SessionsRepo;
    confirm: ConfirmIntakeDeps;
    mentionUserId?: string | null;
  },
  localPr: RevisorLocalPr,
): Promise<GoalMachineOutcome> {
  if (localPr.status === "merged") {
    const result = await intakeDevelopMerge(input.confirm, {
      repo_origin: localPr.repository,
      pr_number: localPr.number,
      pr_title: localPr.title,
      pr_url: null,
    });
    if (result.created) {
      notifyUserDecision({
        kind: "confirm-queued",
        targetSessionId: input.sessionId,
        mentionUserId: input.mentionUserId,
        text: `確認テストがキューに入りました。/confirm start ${result.row.service_code ?? result.row.repo_name} で開始してください。`,
      });
    }
    eventBus.emit({ type: "taskflow.completion_detected", session_id: input.sessionId, pr_number: localPr.number, outcome: "merged", ts: Math.floor(Date.now() / 1000) });
    return "merged";
  }
  if (localPr.status === "open") {
    // failed / action_required は Revisor の終局 inject が修正→再提出を促すので、
    // ここでは待ち (open) として扱い二重に判断を迫らない。
    return "open";
  }
  // closed (取り下げ) — 再開か終了かは人間の判断。
  notifyUserDecision({
    kind: "pr-decision",
    targetSessionId: input.sessionId,
    mentionUserId: input.mentionUserId,
    text: `Revisor local PR #${localPr.number} は ${localPr.status} です。再開するか閉じるか判断してください。`,
  });
  return "missing";
}
