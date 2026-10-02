/**
 * ユーザー / チームの月次予算の集計と判定 (spec/feature/usage-budgets.md §3 §5)。
 *
 * 子会社の日次予算 (subsidiary/budget.ts) と同じく、 期間内に始まったセッションの provider ログ累積トークンを
 * 帰属先ごとに合算する。 ログから読む累積は冪等なので、 再起動しても二重に数えない。
 *
 * - checkLaunch: 起動の入口で、 消費する予算に残りがあるかを返す (予算が無ければ常に許可)。
 * - sweepNotices: 予算ごとに 80% / 100% に達したら、 その月に 1 回だけ本人へ知らせる。 配送に失敗したら記録を戻して次回やり直す。
 *
 * @implements SPEC-USAGE-BUDGET-POLICY
 */

import type { SessionRow } from "../shared/types.js";
import type { UsageBudgetsRepo, UsageBudgetThreshold } from "../db/usage-budgets-repo.js";
import {
  evaluateBudget,
  localMonthKey,
  localMonthRange,
  subjectForLaunch,
  subjectForSession,
  type BudgetEvaluation,
  type BudgetSubject,
} from "./usage-budget.js";

export interface UsageBudgetTrackerDeps {
  budgets: Pick<UsageBudgetsRepo, "find" | "list" | "claimNotice" | "releaseNotice">;
  /** started_at が [startMs, endMs) のセッション。 sessions.started_at は epoch 秒なので adapter が換算する。 */
  sessionsInRange(startMs: number, endMs: number): SessionRow[];
  readUsage(session: SessionRow): Promise<{ total: number } | null>;
  now?: () => number;
}

export interface LaunchBudgetCheck {
  allowed: boolean;
  subject: BudgetSubject | null;
  /** 予算が設定されているときだけ。 */
  evaluation: BudgetEvaluation | null;
}

export interface BudgetNotice {
  subject: BudgetSubject;
  threshold: UsageBudgetThreshold;
  evaluation: BudgetEvaluation;
}

export class UsageBudgetTracker {
  private readonly now: () => number;

  constructor(private readonly deps: UsageBudgetTrackerDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** 今月の消費を帰属先 ("scope:id") ごとに合算する。 */
  async monthlyConsumption(nowMs = this.now()): Promise<Map<string, number>> {
    const [start, end] = localMonthRange(nowMs);
    const totals = new Map<string, number>();
    for (const session of this.deps.sessionsInRange(start, end)) {
      const subject = subjectForSession(session);
      if (!subject) continue;
      const usage = await this.deps.readUsage(session).catch(() => null);
      if (!usage || usage.total <= 0) continue;
      const key = subjectKey(subject);
      totals.set(key, (totals.get(key) ?? 0) + usage.total);
    }
    return totals;
  }

  /** 1 件の予算の今月の状況。 予算が無ければ null。 */
  async status(subject: BudgetSubject, nowMs = this.now()): Promise<BudgetEvaluation | null> {
    const budget = this.deps.budgets.find(subject.scope, subject.targetId);
    if (!budget) return null;
    const consumed = (await this.monthlyConsumption(nowMs)).get(subjectKey(subject)) ?? 0;
    return evaluateBudget(consumed, budget.limit_tokens);
  }

  async checkLaunch(input: { teamId: string | null; requesterUserId: string | null }): Promise<LaunchBudgetCheck> {
    const subject = subjectForLaunch(input);
    if (!subject) return { allowed: true, subject: null, evaluation: null };
    const evaluation = await this.status(subject);
    return { allowed: !evaluation?.exhausted, subject, evaluation };
  }

  /** 予算ごとに閾値の知らせを出す。 出した知らせを返す。 */
  async sweepNotices(deliver: (notice: BudgetNotice) => Promise<boolean>, nowMs = this.now()): Promise<BudgetNotice[]> {
    const budgets = this.deps.budgets.list();
    if (budgets.length === 0) return [];
    const consumption = await this.monthlyConsumption(nowMs);
    const month = localMonthKey(nowMs);
    const delivered: BudgetNotice[] = [];
    for (const budget of budgets) {
      const subject: BudgetSubject = { scope: budget.scope, targetId: budget.target_id };
      const evaluation = evaluateBudget(consumption.get(subjectKey(subject)) ?? 0, budget.limit_tokens);
      if (!evaluation.reached) continue;
      if (!this.deps.budgets.claimNotice(budget.scope, budget.target_id, month, evaluation.reached, nowMs)) continue;
      const notice = { subject, threshold: evaluation.reached, evaluation };
      const ok = await deliver(notice).catch(() => false);
      if (!ok) {
        this.deps.budgets.releaseNotice(budget.scope, budget.target_id, month, evaluation.reached);
        continue;
      }
      delivered.push(notice);
    }
    return delivered;
  }
}

export function subjectKey(subject: BudgetSubject): string {
  return `${subject.scope}:${subject.targetId}`;
}
