/**
 * 個人の AI 予算の組み立て。 SQLite の repository を use case の port へつなぐ。
 *
 * Cc 本体と Bot のプロセスは同じ DB を開くので、 どちらもここから同じ use case を得る。
 * 寿命を持つもの (周期の計上・通知の配達) は呼び出し側の composition root が所有する。
 *
 * @implements spec/feature/personal-ai-budget.md §11
 * @implements SPEC-PBUDGET-CONSUME
 * @implements SPEC-PBUDGET-REWARD
 * @implements SPEC-PBUDGET-ADJUST
 * @implements SPEC-PBUDGET-VIEW
 */

import type Database from "better-sqlite3";
import { PersonalBudgetLedgerRepo } from "../db/personal-budget-ledger-repo.js";
import { PersonalBudgetPeopleRepo } from "../db/personal-budget-people-repo.js";
import { PersonalBudgetUsageRepo } from "../db/personal-budget-usage-repo.js";
import { PersonalBudgetAdjustments } from "./adjustment-service.js";
import { PersonalBudgetDispatch } from "./dispatch-service.js";
import { effectiveMonthlyLimit, type MonthlyLimitResolver } from "./ports.js";
import { PersonalBudgetRewards } from "./reward-service.js";
import { PersonalBudgetView } from "./view-service.js";

export interface PersonalBudgetCompositionDeps {
  db: Database.Database;
  /** 子会社の個人の月間分の既定値 (`subsidiaries.personal_monthly_token_budget`)。 行が無ければ null。 */
  subsidiaryMonthlyDefault: (subsidiaryId: string) => number | null;
  /** 全体の日次 budget が超過中か。 判定できないプロセスでは false を返す。 */
  isGlobalOver: () => boolean;
  /** 設定 `personal_budget.reward.*` の生の値。 */
  readSetting: (key: string) => string | null;
  log?: { info: (message: string) => void; warn: (message: string) => void };
}

export interface PersonalBudgetServices {
  people: PersonalBudgetPeopleRepo;
  ledger: PersonalBudgetLedgerRepo;
  usage: PersonalBudgetUsageRepo;
  monthlyLimit: MonthlyLimitResolver;
  dispatch: PersonalBudgetDispatch;
  rewards: PersonalBudgetRewards;
  adjustments: PersonalBudgetAdjustments;
  view: PersonalBudgetView;
}

export function createPersonalBudget(deps: PersonalBudgetCompositionDeps): PersonalBudgetServices {
  const people = new PersonalBudgetPeopleRepo(deps.db);
  const ledger = new PersonalBudgetLedgerRepo(deps.db);
  const usage = new PersonalBudgetUsageRepo(deps.db);
  const monthlyLimit: MonthlyLimitResolver = (person) =>
    effectiveMonthlyLimit(person.monthly_token_limit, deps.subsidiaryMonthlyDefault(person.subsidiary_id));
  return {
    people,
    ledger,
    usage,
    monthlyLimit,
    dispatch: new PersonalBudgetDispatch({ people, usage, ledger, monthlyLimit, isGlobalOver: deps.isGlobalOver }),
    rewards: new PersonalBudgetRewards({ people, ledger, readSetting: deps.readSetting, log: deps.log }),
    adjustments: new PersonalBudgetAdjustments({ people, ledger }),
    view: new PersonalBudgetView({ people, usage, ledger, monthlyLimit }),
  };
}
