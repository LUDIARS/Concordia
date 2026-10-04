/**
 * 残高と履歴の読み取り (use case)。 本人 (`/budget`) と本社の WebUI が同じ形を使う。
 * 誰に見せるかは呼び出し側 (応答の宛先・API の認可) が決める (CC-PBUDGET-INV-08)。
 *
 * @implements SPEC-PBUDGET-VIEW
 * @implements spec/feature/personal-ai-budget.md §7
 */

import type { BudgetPerson, LedgerEntry, LedgerStore, MonthlyLimitResolver, PeopleStore, UsageStore } from "./ports.js";
import { localMonth, type BudgetPlatform } from "./types.js";

export interface BudgetSummary {
  person: BudgetPerson;
  period: string;
  /** 効いている月間分の上限。 0 = 上限なし。 */
  monthlyLimit: number;
  monthlyUsed: number;
  /** 月間分の残り。 上限なしなら null。 */
  monthlyRemaining: number | null;
  rewardBalance: number;
}

export interface BudgetView extends BudgetSummary {
  recent: LedgerEntry[];
}

export interface ViewServiceDeps {
  people: PeopleStore;
  usage: UsageStore;
  ledger: LedgerStore;
  monthlyLimit: MonthlyLimitResolver;
  now?: () => number;
}

/** `/budget` に出す直近の履歴の件数。 */
export const RECENT_LEDGER_ENTRIES = 5;

export class PersonalBudgetView {
  private readonly now: () => number;

  constructor(private readonly deps: ViewServiceDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  summarize(person: BudgetPerson): BudgetSummary {
    const period = localMonth(this.now());
    const monthlyLimit = this.deps.monthlyLimit(person);
    const monthlyUsed = this.deps.usage.monthlyUsed(person.id, period);
    return {
      person,
      period,
      monthlyLimit,
      monthlyUsed,
      monthlyRemaining: monthlyLimit > 0 ? Math.max(0, monthlyLimit - monthlyUsed) : null,
      rewardBalance: this.deps.ledger.balance(person.id),
    };
  }

  /**
   * 本人の残高と直近の履歴。 `subsidiaryId` があればその会社の行だけ、 無ければその人の全社分。
   * 行が無い人には何も作らず空を返す (見るだけの操作で個人の行を増やさない)。
   */
  forUser(input: { platform: BudgetPlatform; platformUserId: string; subsidiaryId?: string | null }): BudgetView[] {
    const people = input.subsidiaryId
      ? [this.deps.people.find({
        subsidiaryId: input.subsidiaryId, platform: input.platform, platformUserId: input.platformUserId,
      })].filter((person): person is BudgetPerson => person !== null)
      : this.deps.people.listByUser(input.platform, input.platformUserId);
    return people.map((person) => ({
      ...this.summarize(person),
      recent: this.deps.ledger.listForPerson(person.id, { limit: RECENT_LEDGER_ENTRIES, offset: 0 }).entries,
    }));
  }
}
