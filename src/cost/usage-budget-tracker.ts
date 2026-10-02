/**
 * ユーザー / チームの月次予算の集計と判定 (spec/feature/usage-budgets.md §3 §5)。
 *
 * 子会社の日次予算 (subsidiary/budget.ts) と同じく、 期間内に始まったセッションの provider ログ累積トークンを
 * 帰属先ごとに合算する。 ログから読む累積は冪等なので、 再起動しても二重に数えない。
 *
 * - 消費は「人の指示ごと」に帰属先を分け (usage-attribution.ts)、 部署と消費する人の属性の倍率を掛けた額で数える
 *   (budget-multiplier.ts)。 時刻つきの消費が読めないセッションは合計を起動時の帰属先へ付ける。
 * - checkLaunch: 起動の入口で、 消費する予算に残りがあるかを返す (予算が無ければ常に許可)。
 * - sweepNotices: 予算ごとに 80% / 100% に達したら、 その月に 1 回だけ本人へ知らせる。 配送に失敗したら記録を戻して次回やり直す。
 * - cachedMonthlyConsumption: ツール実行ごとの判定 (ハーネスの gate) 用。 集計は重いので数分キャッシュする。
 *
 * @implements SPEC-USAGE-BUDGET-POLICY
 */

import type { SessionEventRow, SessionRow } from "../shared/types.js";
import type { UsageBudgetsRepo, UsageBudgetThreshold } from "../db/usage-budgets-repo.js";
import {
  evaluateBudget,
  localMonthKey,
  localMonthRange,
  subjectForLaunch,
  type BudgetEvaluation,
  type BudgetSubject,
} from "./usage-budget.js";
import { attributeTotal, attributeUsage, sessionAttribution, type SessionAttribution } from "./usage-attribution.js";
import { chargedTokens, DEFAULT_COST_MULTIPLIER } from "./budget-multiplier.js";
import type { UsagePoint } from "./usage-timeline.js";

/** ツール実行ごとの判定で使う集計のキャッシュ期間 (既定 3 分)。 */
export const DEFAULT_CONSUMPTION_CACHE_MS = 3 * 60 * 1000;

export interface UsageBudgetTrackerDeps {
  budgets: Pick<UsageBudgetsRepo, "find" | "list" | "claimNotice" | "releaseNotice">;
  /** started_at が [startMs, endMs) のセッション。 sessions.started_at は epoch 秒なので adapter が換算する。 */
  sessionsInRange(startMs: number, endMs: number): SessionRow[];
  /** セッション全体の累積 (時刻つきの消費が読めないときに使う)。 */
  readUsage(session: SessionRow): Promise<{ total: number } | null>;
  /** 時刻つきの消費。 未注入・null ならセッション全体の合計に倒す。 */
  readTimeline?(session: SessionRow): Promise<UsagePoint[] | null>;
  /** セッションの inject イベント (人の指示の作者と時刻)。 未注入なら全区間を起動時の帰属先へ付ける。 */
  sessionEvents?(sessionId: string): SessionEventRow[];
  /** 部署の倍率。 未注入・部署なしは 1。 */
  departmentMultiplier?(departmentId: string | null): number;
  /** 消費する人 (Discord の利用者) の属性の倍率。 未注入・不明は 1。 */
  roleMultiplier?(userId: string | null): number;
  now?: () => number;
  /** cachedMonthlyConsumption のキャッシュ期間 (ms)。 */
  cacheTtlMs?: number;
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
  private cache: { month: string; computedAt: number; totals: Map<string, number> } | null = null;

  constructor(private readonly deps: UsageBudgetTrackerDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** セッションの帰属の前提 (起動時の帰属先・起動者・人の指示)。 */
  attributionFor(session: SessionRow): SessionAttribution {
    return sessionAttribution(session, this.deps.sessionEvents?.(session.id) ?? []);
  }

  /** 今月の消費 (倍率込み) を帰属先 ("scope:id") ごとに合算する。 結果はキャッシュにも入れる。 */
  async monthlyConsumption(nowMs = this.now()): Promise<Map<string, number>> {
    const [start, end] = localMonthRange(nowMs);
    const totals = new Map<string, number>();
    for (const session of this.deps.sessionsInRange(start, end)) {
      for (const charge of await this.sessionCharges(session)) {
        const key = subjectKey(charge.subject);
        totals.set(key, (totals.get(key) ?? 0) + charge.amount);
      }
    }
    this.cache = { month: localMonthKey(nowMs), computedAt: nowMs, totals };
    return totals;
  }

  /** キャッシュ期間内ならキャッシュを返し、 切れていれば数え直す (ツール実行ごとの判定用)。 */
  async cachedMonthlyConsumption(nowMs = this.now()): Promise<Map<string, number>> {
    const ttl = this.deps.cacheTtlMs ?? DEFAULT_CONSUMPTION_CACHE_MS;
    const cache = this.cache;
    if (cache && cache.month === localMonthKey(nowMs) && nowMs - cache.computedAt < ttl) return cache.totals;
    return this.monthlyConsumption(nowMs);
  }

  /** 次の判定で数え直させる (予算や倍率を変えたとき)。 */
  invalidate(): void {
    this.cache = null;
  }

  private async sessionCharges(session: SessionRow): Promise<Array<{ subject: BudgetSubject; amount: number }>> {
    const attribution = this.attributionFor(session);
    // 起動時の帰属先が無い = 起動者も分からないので、 助けに入った人も区別できない。 何も消費しない (読み出しを省く)。
    if (!attribution.defaultSubject) return [];
    const timeline = this.deps.readTimeline ? await this.deps.readTimeline(session).catch(() => null) : null;
    let charges;
    if (timeline) {
      charges = attributeUsage(attribution, timeline);
    } else {
      const usage = await this.deps.readUsage(session).catch(() => null);
      charges = attributeTotal(attribution, usage?.total ?? 0);
    }
    const departmentMultiplier = this.deps.departmentMultiplier?.(session.department_id ?? null) ?? DEFAULT_COST_MULTIPLIER;
    return charges.map((charge) => ({
      subject: charge.subject,
      amount: chargedTokens(
        charge.tokens,
        departmentMultiplier,
        this.deps.roleMultiplier?.(charge.personUserId) ?? DEFAULT_COST_MULTIPLIER,
      ),
    }));
  }

  /** 1 件の予算の今月の状況。 予算が無ければ null。 */
  async status(subject: BudgetSubject, nowMs = this.now()): Promise<BudgetEvaluation | null> {
    const budget = this.deps.budgets.find(subject.scope, subject.targetId);
    if (!budget) return null;
    const consumed = (await this.monthlyConsumption(nowMs)).get(subjectKey(subject)) ?? 0;
    return evaluateBudget(consumed, budget.limit_tokens);
  }

  /** キャッシュした集計での 1 件の予算の状況 (ツール実行ごとの判定用)。 予算が無ければ null。 */
  async cachedStatus(subject: BudgetSubject, nowMs = this.now()): Promise<BudgetEvaluation | null> {
    const budget = this.deps.budgets.find(subject.scope, subject.targetId);
    if (!budget) return null;
    const consumed = (await this.cachedMonthlyConsumption(nowMs)).get(subjectKey(subject)) ?? 0;
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
