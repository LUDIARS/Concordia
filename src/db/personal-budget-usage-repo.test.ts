import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { PersonalBudgetLedgerRepo } from "./personal-budget-ledger-repo.js";
import { PersonalBudgetPeopleRepo } from "./personal-budget-people-repo.js";
import { PersonalBudgetUsageRepo, type ConsumptionState } from "./personal-budget-usage-repo.js";

let usage: PersonalBudgetUsageRepo;
let ledger: PersonalBudgetLedgerRepo;
let personId: string;

/** 月間分へ全部載せる単純な計画 (割り当ての判断はこのテストの対象外)。 */
const allToMonthly = (total: number) => (state: ConsumptionState) => {
  const delta = Math.max(0, total - (state.lastTotal ?? 0));
  return { delta, baseline: 0, monthly: delta, reward: 0 };
};

beforeEach(() => {
  const db = makeTestDb();
  usage = new PersonalBudgetUsageRepo(db);
  ledger = new PersonalBudgetLedgerRepo(db);
  personId = new PersonalBudgetPeopleRepo(db).ensure({ subsidiaryId: "glab", platform: "discord", platformUserId: "111" }).id;
});

describe("PersonalBudgetUsageRepo.applyConsumption (CC-PBUDGET-INV-05)", () => {
  it("advances the baseline and the monthly usage together", () => {
    expect(usage.lastTotal("s1")).toBeNull();
    expect(usage.applyConsumption({ sessionId: "s1", personId, period: "2026-10", total: 1_000, plan: allToMonthly(1_000) }))
      .toEqual({ delta: 1_000, monthly: 1_000, reward: 0 });
    expect(usage.lastTotal("s1")).toBe(1_000);
    expect(usage.monthlyUsed(personId, "2026-10")).toBe(1_000);

    // 同じ累積を渡しても進まない。
    expect(usage.applyConsumption({ sessionId: "s1", personId, period: "2026-10", total: 1_000, plan: allToMonthly(1_000) }))
      .toEqual({ delta: 0, monthly: 0, reward: 0 });
    expect(usage.monthlyUsed(personId, "2026-10")).toBe(1_000);
  });

  it("hands the plan the state it read inside the transaction", () => {
    ledger.grant({ personId, kind: "tabula", sourceRef: "pub-1", tokens: 700 });
    usage.applyConsumption({ sessionId: "s1", personId, period: "2026-10", total: 200, plan: allToMonthly(200) });
    const states: ConsumptionState[] = [];
    usage.applyConsumption({
      sessionId: "s1", personId, period: "2026-10", total: 500,
      plan: (state) => { states.push(state); return { delta: 300, baseline: 0, monthly: 300, reward: 0 }; },
    });
    expect(states).toEqual([{ lastTotal: 200, monthlyUsed: 200, rewardBalance: 700 }]);
  });

  it("records only the baseline for a first sight without a delta", () => {
    usage.applyConsumption({
      sessionId: "old", personId, period: "2026-10", total: 8_000,
      plan: () => ({ delta: 0, baseline: 8_000, monthly: 0, reward: 0 }),
    });
    expect(usage.lastTotal("old")).toBe(8_000);
    expect(usage.monthlyUsed(personId, "2026-10")).toBe(0);
  });

  it("keeps one reward debit row per session and month, and bounds it by the balance", () => {
    ledger.grant({ personId, kind: "tabula", sourceRef: "pub-1", tokens: 500 });
    usage.applyConsumption({
      sessionId: "s1", personId, period: "2026-10", total: 300,
      plan: () => ({ delta: 300, baseline: 0, monthly: 0, reward: 300 }),
    });
    // 計画が残高 (200) を超える 900 を報酬分へ割り当てても、残高までしか引かない。
    expect(usage.applyConsumption({
      sessionId: "s1", personId, period: "2026-10", total: 1_200,
      plan: () => ({ delta: 900, baseline: 0, monthly: 0, reward: 900 }),
    })).toEqual({ delta: 900, monthly: 700, reward: 200 });

    const debits = ledger.listForPerson(personId, { limit: 10, offset: 0 }).entries.filter((entry) => entry.entry_type === "debit");
    expect(debits).toHaveLength(1);
    expect(debits[0]).toMatchObject({ tokens: -500, session_id: "s1", period: "2026-10", notify_state: "none" });
    expect(ledger.balance(personId)).toBe(0);
    expect(usage.monthlyUsed(personId, "2026-10")).toBe(700);
  });

  it("writes a separate debit row for another month of the same session", () => {
    ledger.grant({ personId, kind: "tabula", sourceRef: "pub-1", tokens: 500 });
    usage.applyConsumption({
      sessionId: "s1", personId, period: "2026-10", total: 100,
      plan: () => ({ delta: 100, baseline: 0, monthly: 0, reward: 100 }),
    });
    usage.applyConsumption({
      sessionId: "s1", personId, period: "2026-11", total: 250,
      plan: () => ({ delta: 150, baseline: 0, monthly: 0, reward: 150 }),
    });
    const debits = ledger.listForPerson(personId, { limit: 10, offset: 0 }).entries.filter((entry) => entry.entry_type === "debit");
    expect(debits.map((entry) => [entry.period, entry.tokens]).sort()).toEqual([["2026-10", -100], ["2026-11", -150]]);
  });
});
