/**
 * ユーザー / チームの月次トークン上限予算の判断 (spec/feature/usage-budgets.md、 2026-10-02 neco 指示)。
 *
 * 「それぞれのユーザーに上限予算があり、 相談等はその予算内で出来る。 チームに予算をつけ、
 *  チームで起動したセッションはチームの予算を消費する」。
 *
 * - 1 セッションはどちらか片方だけを消費する: チームで起動したならチーム、 それ以外は依頼者 (Discord ユーザー)。
 * - 期間は local の暦月。 消費はその月に始まったセッションの累積トークン (月の途中で予算を変えても数え直す)。
 * - 予算が無い (行が無い) なら無制限。 上限 0 は「使えない」。
 *
 * @implements SPEC-USAGE-BUDGET-POLICY
 */

import type { UsageBudgetScope, UsageBudgetThreshold } from "../db/usage-budgets-repo.js";

export interface BudgetSubject {
  scope: UsageBudgetScope;
  targetId: string;
}

const DISCORD_USER_ID = /^\d{5,32}$/;

/** 起動要求からどの予算を消費するかを決める。 決められなければ null (予算を見ない)。 */
export function subjectForLaunch(input: { teamId: string | null; requesterUserId: string | null }): BudgetSubject | null {
  if (input.teamId) return { scope: "team", targetId: input.teamId };
  if (input.requesterUserId && DISCORD_USER_ID.test(input.requesterUserId)) return { scope: "user", targetId: input.requesterUserId };
  return null;
}

/** 起動済みのセッションがどの予算を消費したか (チーム → 依頼者の順)。 */
export function subjectForSession(session: { team_id?: string | null; metadata: string | null }): BudgetSubject | null {
  return subjectForLaunch({ teamId: session.team_id ?? null, requesterUserId: readRequesterUserId(session.metadata) });
}

function readRequesterUserId(metadata: string | null): string | null {
  if (!metadata) return null;
  try {
    const value = (JSON.parse(metadata) as { discord_requester_user_id?: unknown }).discord_requester_user_id;
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

export function sameSubject(a: BudgetSubject | null, b: BudgetSubject): boolean {
  return a !== null && a.scope === b.scope && a.targetId === b.targetId;
}

/** epoch(ms) → その local 月の [1 日 00:00, 翌月 1 日 00:00) の epoch(ms) 範囲。 */
export function localMonthRange(nowMs: number): [number, number] {
  const d = new Date(nowMs);
  return [new Date(d.getFullYear(), d.getMonth(), 1).getTime(), new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime()];
}

/** 通知の記録に使う月の名前 ("YYYY-MM"、 local)。 */
export function localMonthKey(nowMs: number): string {
  const d = new Date(nowMs);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export interface BudgetEvaluation {
  consumedTokens: number;
  limitTokens: number;
  /** 0〜 (1 で使い切り)。 */
  ratio: number;
  /** 残りが無い (新しい起動を止める)。 */
  exhausted: boolean;
  /** 到達した最も高い通知の閾値。 */
  reached: UsageBudgetThreshold | null;
}

export function evaluateBudget(consumedTokens: number, limitTokens: number): BudgetEvaluation {
  const limit = Math.max(0, Math.floor(limitTokens));
  const consumed = Math.max(0, Math.floor(consumedTokens));
  const ratio = limit === 0 ? 1 : consumed / limit;
  return {
    consumedTokens: consumed,
    limitTokens: limit,
    ratio,
    exhausted: consumed >= limit,
    reached: ratio >= 1 ? 100 : ratio >= 0.8 ? 80 : null,
  };
}

/** 本人への知らせの文面 (起動を止めたとき・閾値に達したとき)。 数値は 1,234 形式。 */
export function budgetNoticeText(subject: BudgetSubject, evaluation: BudgetEvaluation): string {
  const who = subject.scope === "team" ? "チーム" : "あなた";
  const used = `${evaluation.consumedTokens.toLocaleString("en-US")} / ${evaluation.limitTokens.toLocaleString("en-US")} トークン`;
  if (evaluation.exhausted) return `${who}の今月の予算を使い切りました (${used})。新しいセッションは起動できません。`;
  return `${who}の今月の予算の ${Math.floor(evaluation.ratio * 100)}% を使いました (${used})。`;
}
