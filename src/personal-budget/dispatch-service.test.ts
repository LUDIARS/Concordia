import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { createPersonalBudget, type PersonalBudgetServices } from "./composition.js";
import { renderDispatchStop } from "./dispatch-service.js";
import { localMonth } from "./types.js";

let budget: PersonalBudgetServices;
let monthlyDefault: number;
let globalOver: boolean;

const request = { subsidiaryId: "glab", platform: "discord" as const, userId: "111", userLabel: "alice", subsidiaryOver: false };

function seedUsage(personId: string, tokens: number): void {
  budget.usage.applyConsumption({
    sessionId: `seed-${tokens}`, personId, period: localMonth(Date.now()), total: tokens,
    plan: () => ({ delta: tokens, baseline: 0, monthly: tokens, reward: 0 }),
  });
}

beforeEach(() => {
  monthlyDefault = 0;
  globalOver = false;
  budget = createPersonalBudget({
    db: makeTestDb(),
    subsidiaryMonthlyDefault: () => monthlyDefault,
    isGlobalOver: () => globalOver,
    readSetting: () => null,
  });
});

describe("PersonalBudgetDispatch.admit", () => {
  it("enrolls the requester and lets a person without a monthly limit through as before", () => {
    expect(budget.dispatch.admit(request)).toEqual({ allow: true, source: "none" });
    expect(budget.people.find({ subsidiaryId: "glab", platform: "discord", platformUserId: "111" }))
      .toMatchObject({ display_name: "alice", monthly_token_limit: null });
  });

  it("keeps the pre-existing behaviour for a person without a monthly limit, whatever the global cap says", () => {
    globalOver = true;
    expect(budget.dispatch.admit(request)).toEqual({ allow: true, source: "none" });
    expect(budget.dispatch.admit({ ...request, subsidiaryOver: true }))
      .toEqual({ allow: false, reason: "subsidiary_over", rewardBalance: 0, inEffect: false });
  });

  it("stops a person whose monthly allowance and reward balance are both used up", () => {
    monthlyDefault = 1_000;
    const person = budget.people.ensure({ subsidiaryId: "glab", platform: "discord", platformUserId: "111" });
    seedUsage(person.id, 1_000);
    expect(budget.dispatch.admit(request))
      .toEqual({ allow: false, reason: "monthly_exhausted", rewardBalance: 0, inEffect: true });

    budget.ledger.grant({ personId: person.id, kind: "tabula", sourceRef: "pub-1", tokens: 300 });
    expect(budget.dispatch.admit(request)).toEqual({ allow: true, source: "reward" });
  });

  it("prefers the person's own monthly limit over the subsidiary default", () => {
    monthlyDefault = 1_000;
    const person = budget.people.ensure({ subsidiaryId: "glab", platform: "discord", platformUserId: "111" });
    seedUsage(person.id, 1_500);
    budget.people.setMonthlyLimit(person.id, 5_000);
    expect(budget.dispatch.admit(request)).toEqual({ allow: true, source: "monthly" });
    // 0 の上書きは「この人は上限なし」。
    budget.people.setMonthlyLimit(person.id, 0);
    expect(budget.dispatch.admit(request)).toEqual({ allow: true, source: "none" });
  });

  it("lets a person with a reward balance through while the subsidiary cap is exceeded, unless the global cap is too", () => {
    const person = budget.people.ensure({ subsidiaryId: "glab", platform: "discord", platformUserId: "111" });
    budget.ledger.grant({ personId: person.id, kind: "tabula", sourceRef: "pub-1", tokens: 300 });
    expect(budget.dispatch.admit({ ...request, subsidiaryOver: true })).toEqual({ allow: true, source: "reward" });
    globalOver = true;
    expect(budget.dispatch.admit({ ...request, subsidiaryOver: true }))
      .toEqual({ allow: false, reason: "global_over", rewardBalance: 300, inEffect: true });
  });

  it("does not apply the personal budget to head-office requesters and creates no row for them (CC-PBUDGET-INV-07)", () => {
    globalOver = true;
    expect(budget.dispatch.admit({ ...request, subsidiaryId: null })).toEqual({ allow: true, source: "none" });
    expect(budget.people.list({ limit: 10, offset: 0 }).total).toBe(0);
  });
});

describe("renderDispatchStop", () => {
  it("gives the reason and points to /budget without printing a balance (CC-PBUDGET-INV-08)", () => {
    for (const reason of ["global_over", "subsidiary_over", "monthly_exhausted"] as const) {
      const text = renderDispatchStop(reason);
      expect(text).toContain("/budget");
      expect(text).not.toMatch(/\d/);
    }
    expect(renderDispatchStop("monthly_exhausted")).toContain("月間分");
  });
});
