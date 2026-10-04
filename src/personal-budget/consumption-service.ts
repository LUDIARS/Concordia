/**
 * 消費の計上 (use case)。 依頼者を持つセッションの累積トークンの正の差分を、 その個人の
 * 月間分と報酬分へ割り当てる。
 *
 * baseline・月間分の累積・報酬分の debit は保存側が 1 トランザクションで進めるので、 再起動を
 * 跨いでも同じ消費を二重に引かない (CC-PBUDGET-INV-05)。 本社メンバーと依頼者の無いセッションは
 * 数えない (CC-PBUDGET-INV-07)。 残高や消費量はログへ出さない (CC-PBUDGET-INV-08)。
 *
 * @implements SPEC-PBUDGET-CONSUME
 * @implements spec/feature/personal-ai-budget.md §3 / §10
 */

import { allocateConsumption, consumptionDelta, initialBaseline } from "./allocation.js";
import { resolveBudgetPerson } from "./person-resolution.js";
import type { MonthlyLimitResolver, PeopleStore, UsageStore } from "./ports.js";
import { localMonth, type BudgetPlatform } from "./types.js";

/** 計上の対象になりうるセッション 1 本の事実。 */
export interface ConsumptionSession {
  id: string;
  subsidiaryId: string | null;
  requesterPlatform: BudgetPlatform | null;
  requesterUserId: string | null;
  startedAtMs: number;
}

export interface ConsumptionDeps {
  /** 最近動いたセッション。 */
  sessions: () => ConsumptionSession[];
  /** セッションの累積トークン。 読めなければ null (今回は数えない)。 */
  readTotal: (sessionId: string) => Promise<number | null>;
  people: PeopleStore;
  usage: UsageStore;
  monthlyLimit: MonthlyLimitResolver;
  /** 子会社の日次 budget が超過中か。 超過中の消費は報酬分から引く。 */
  isSubsidiaryOver: (subsidiaryId: string) => Promise<boolean>;
  now?: () => number;
  log?: { warn: (message: string) => void };
}

export interface ConsumptionSummary {
  /** 個人へ帰属できたセッション数。 */
  attributed: number;
  /** 対象外 (本社・依頼者なし) で数えなかったセッション数。 */
  skipped: number;
  /** 読み取りや保存に失敗したセッション数。 次の周期で数え直す。 */
  failed: number;
}

export class PersonalBudgetConsumption {
  private readonly now: () => number;

  constructor(private readonly deps: ConsumptionDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** 1 周期ぶんの計上。 1 本の失敗で残りを止めない。 */
  async sampleOnce(): Promise<ConsumptionSummary> {
    const summary: ConsumptionSummary = { attributed: 0, skipped: 0, failed: 0 };
    const subsidiaryOver = new Map<string, boolean>();
    for (const session of this.deps.sessions()) {
      const resolved = resolveBudgetPerson({
        subsidiaryId: session.subsidiaryId,
        platform: session.requesterPlatform,
        platformUserId: session.requesterUserId,
      });
      if (!resolved.ok) {
        summary.skipped += 1;
        continue;
      }
      try {
        const total = await this.deps.readTotal(session.id);
        if (total === null) {
          summary.skipped += 1;
          continue;
        }
        const subsidiaryId = resolved.identity.subsidiaryId;
        let over = subsidiaryOver.get(subsidiaryId);
        if (over === undefined) {
          over = await this.deps.isSubsidiaryOver(subsidiaryId);
          subsidiaryOver.set(subsidiaryId, over);
        }
        const now = this.now();
        const person = this.deps.people.ensure(resolved.identity, "", now);
        const monthlyLimit = this.deps.monthlyLimit(person);
        const isOver = over;
        this.deps.usage.applyConsumption({
          sessionId: session.id,
          personId: person.id,
          // 月をまたぐセッションは、 差分を数えた時点の月へ計上する。
          period: localMonth(now),
          total,
          now,
          plan: (state) => {
            const baseline = state.lastTotal ?? initialBaseline({
              sessionStartedAtMs: session.startedAtMs,
              personCreatedAtMs: person.created_at,
              total,
            });
            const delta = consumptionDelta(baseline, total);
            const allocation = allocateConsumption({
              delta,
              monthlyLimit,
              monthlyUsed: state.monthlyUsed,
              rewardBalance: state.rewardBalance,
              subsidiaryOver: isOver,
            });
            return { delta, baseline, monthly: allocation.monthly, reward: allocation.reward };
          },
        });
        summary.attributed += 1;
      } catch (error) {
        summary.failed += 1;
        this.deps.log?.warn(`personal budget consumption failed session=${session.id}: ${(error as Error).message}`);
      }
    }
    return summary;
  }
}
