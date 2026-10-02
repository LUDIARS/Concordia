/**
 * 予算切れで中断したセッションの再開 (spec/feature/usage-budgets.md §5.3)。
 *
 * - offerBudgetResumes: 通知の見回りの周期で、 予算が戻った (月が替わった・上限を上げた) 中断を探し、 1 回だけ
 *   「再開」ボタンを出す知らせを流す。
 * - resumeSuspendedSession: ボタンを押した人が再開できる人か・予算が戻っているかを確かめ、 `claude --resume` で起動し直す。
 *   起動できたら中断の記録に再開した時刻・人を残す (同じ中断を二度起動しない)。
 *
 * @implements SPEC-USAGE-BUDGET-SUSPEND
 */

import type { SessionRow } from "../shared/types.js";
import type { BudgetEvaluation, BudgetSubject } from "./usage-budget.js";
import {
  BUDGET_SUSPENSION_KEY,
  canResumeSuspension,
  isResumable,
  isSuspended,
  readSuspension,
  type BudgetSuspension,
} from "./budget-suspension.js";

function subjectOf(suspension: BudgetSuspension): BudgetSubject {
  return { scope: suspension.scope, targetId: suspension.target_id };
}

export interface BudgetResumeOfferDeps {
  /** 中断の記録を持つセッション。 */
  listSuspended(): SessionRow[];
  /** 帰属先の予算の状況 (予算が無ければ null)。 */
  status(subject: BudgetSubject): Promise<BudgetEvaluation | null>;
  mergeMetadata(id: string, partial: Record<string, unknown>): void;
  /** 中断したセッションのスレッドへ「再開」ボタンを出す知らせ。 */
  offer(sessionId: string, text: string): void;
  now?: () => number;
}

export const BUDGET_RESUME_OFFER_TEXT = "予算が戻りました。「再開」を押すと、中断した作業を同じ会話から再開します。";

/** 予算が戻った中断に 1 回だけ「再開」を出す。 出したセッションの id を返す。 */
export async function offerBudgetResumes(deps: BudgetResumeOfferDeps): Promise<string[]> {
  const offered: string[] = [];
  for (const session of deps.listSuspended()) {
    const suspension = readSuspension(session.metadata);
    if (!isSuspended(suspension) || suspension.resume_offered_at) continue;
    const evaluation = await deps.status(subjectOf(suspension));
    if (!isResumable({ suspension, evaluation })) continue;
    deps.mergeMetadata(session.id, {
      [BUDGET_SUSPENSION_KEY]: { ...suspension, resume_offered_at: (deps.now ?? Date.now)() },
    });
    deps.offer(session.id, BUDGET_RESUME_OFFER_TEXT);
    offered.push(session.id);
  }
  return offered;
}

export interface BudgetResumeDeps {
  findSession(id: string): SessionRow | null;
  /** 帰属先の予算の状況 (数え直した最新の値)。 予算が無ければ null。 */
  status(subject: BudgetSubject): Promise<BudgetEvaluation | null>;
  /** 管理者 (社員名簿の執行役員) か。 */
  isAdmin(userId: string): boolean;
  launch(session: SessionRow, suspension: BudgetSuspension): Promise<{ ok: true; pid: number | null } | { ok: false; error: string }>;
  mergeMetadata(id: string, partial: Record<string, unknown>): void;
  now?: () => number;
}

export type BudgetResumeResult =
  | { ok: true; pid: number | null }
  | { ok: false; status: 400 | 402 | 403 | 404 | 409 | 502; error: string };

export async function resumeSuspendedSession(
  deps: BudgetResumeDeps,
  sessionId: string,
  actorUserId: string,
): Promise<BudgetResumeResult> {
  const session = deps.findSession(sessionId);
  if (!session) return { ok: false, status: 404, error: "not_found" };
  const suspension = readSuspension(session.metadata);
  if (!suspension) return { ok: false, status: 404, error: "not_suspended" };
  if (!isSuspended(suspension)) return { ok: false, status: 409, error: "already_resumed" };
  if (!canResumeSuspension({ suspension, actorUserId, actorIsAdmin: deps.isAdmin(actorUserId) })) {
    return { ok: false, status: 403, error: "resume_not_allowed" };
  }
  if (!suspension.conversation_id) return { ok: false, status: 400, error: "conversation_unknown" };
  const evaluation = await deps.status(subjectOf(suspension));
  if (!isResumable({ suspension, evaluation })) return { ok: false, status: 402, error: "budget_still_exhausted" };
  // 予算の確認を待つ間に別の人が押していれば起動しない。 読み直しから記録までの間に await を挟まないので、
  // 二度押しでも起動は 1 回だけ (起動に失敗したら記録を戻して押し直せるようにする)。
  const latest = readSuspension(deps.findSession(sessionId)?.metadata ?? null);
  if (!isSuspended(latest)) return { ok: false, status: 409, error: "already_resumed" };
  const claimed: BudgetSuspension = { ...latest, resumed_at: (deps.now ?? Date.now)(), resumed_by: actorUserId };
  deps.mergeMetadata(session.id, { [BUDGET_SUSPENSION_KEY]: claimed });
  const launched = await deps.launch(session, latest).catch((error: unknown) => ({ ok: false as const, error: (error as Error).message }));
  if (!launched.ok) {
    deps.mergeMetadata(session.id, { [BUDGET_SUSPENSION_KEY]: { ...latest, resumed_at: null, resumed_by: null } });
    return { ok: false, status: 502, error: launched.error };
  }
  deps.mergeMetadata(session.id, { [BUDGET_SUSPENSION_KEY]: { ...claimed, resumed_pid: launched.pid } });
  return { ok: true, pid: launched.pid };
}
