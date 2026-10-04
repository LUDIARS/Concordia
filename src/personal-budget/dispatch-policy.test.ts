import { describe, expect, it } from "vitest";
import { decideDispatch, isPersonalBudgetInEffect } from "./dispatch-policy.js";

const person = (monthlyLimit: number, monthlyUsed: number, rewardBalance: number) => ({ monthlyLimit, monthlyUsed, rewardBalance });

describe("decideDispatch — spec §3 の表", () => {
  it("全体が超過中は、月間分と報酬分が残っていても止める (CC-PBUDGET-INV-03)", () => {
    expect(decideDispatch({ globalOver: true, subsidiaryOver: false, person: person(1_000, 0, 500) }))
      .toEqual({ allow: false, reason: "global_over", rewardBalance: 500, inEffect: true });
  });

  it("月間分が残っていれば月間分で通す", () => {
    expect(decideDispatch({ globalOver: false, subsidiaryOver: false, person: person(1_000, 999, 0) }))
      .toEqual({ allow: true, source: "monthly" });
  });

  it("月間分が尽きても報酬分があれば報酬分で通す", () => {
    expect(decideDispatch({ globalOver: false, subsidiaryOver: false, person: person(1_000, 1_000, 1) }))
      .toEqual({ allow: true, source: "reward" });
  });

  it("月間分も報酬分も無ければ止める (CC-PBUDGET-INV-02)", () => {
    expect(decideDispatch({ globalOver: false, subsidiaryOver: false, person: person(1_000, 1_200, 0) }))
      .toEqual({ allow: false, reason: "monthly_exhausted", rewardBalance: 0, inEffect: true });
  });

  it("子会社が超過中は月間分が残っていても月間分では通さず、報酬分が正の個人だけ通す", () => {
    expect(decideDispatch({ globalOver: false, subsidiaryOver: true, person: person(1_000, 0, 10) }))
      .toEqual({ allow: true, source: "reward" });
    expect(decideDispatch({ globalOver: false, subsidiaryOver: true, person: person(1_000, 0, 0) }))
      .toEqual({ allow: false, reason: "subsidiary_over", rewardBalance: 0, inEffect: true });
  });
});

describe("decideDispatch — 月間分の上限が 0 (既定) の個人は現状の動きのまま", () => {
  // 導入前の動き: 子会社の日次 budget が超過していれば止め、そうでなければ通す。全体の budget はこの経路で見ていない。
  it.each([
    { globalOver: false, subsidiaryOver: false, allow: true },
    { globalOver: true, subsidiaryOver: false, allow: true },
    { globalOver: false, subsidiaryOver: true, allow: false },
    { globalOver: true, subsidiaryOver: true, allow: false },
  ])("上限 0・報酬分 0: global=$globalOver subsidiary=$subsidiaryOver → allow=$allow", ({ globalOver, subsidiaryOver, allow }) => {
    const decision = decideDispatch({ globalOver, subsidiaryOver, person: person(0, 5_000_000, 0) });
    expect(decision).toEqual(allow
      ? { allow: true, source: "none" }
      : { allow: false, reason: "subsidiary_over", rewardBalance: 0, inEffect: false });
  });

  it("個人を特定できない依頼 (本社・依頼者なし) も同じ動きになる (CC-PBUDGET-INV-07)", () => {
    expect(decideDispatch({ globalOver: true, subsidiaryOver: false, person: null })).toEqual({ allow: true, source: "none" });
    expect(decideDispatch({ globalOver: false, subsidiaryOver: true, person: null }))
      .toEqual({ allow: false, reason: "subsidiary_over", rewardBalance: 0, inEffect: false });
  });

  it("上限 0 でも報酬分を持つ個人は、どれだけ使っていても月間分で通る (報酬分は引かれない)", () => {
    expect(decideDispatch({ globalOver: false, subsidiaryOver: false, person: person(0, 9_000_000, 300_000) }))
      .toEqual({ allow: true, source: "monthly" });
  });
});

describe("isPersonalBudgetInEffect", () => {
  it("is in effect only with a monthly limit or a positive reward balance", () => {
    expect(isPersonalBudgetInEffect(null)).toBe(false);
    expect(isPersonalBudgetInEffect(person(0, 100, 0))).toBe(false);
    expect(isPersonalBudgetInEffect(person(1, 0, 0))).toBe(true);
    expect(isPersonalBudgetInEffect(person(0, 0, 1))).toBe(true);
  });
});
