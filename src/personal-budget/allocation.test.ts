import { describe, expect, it } from "vitest";
import { allocateConsumption, consumptionDelta, initialBaseline } from "./allocation.js";
import { localMonth } from "./types.js";

describe("allocateConsumption (CC-PBUDGET-INV-01 / 02)", () => {
  it("draws from the monthly allowance first and only the shortfall from the reward balance", () => {
    expect(allocateConsumption({
      delta: 500, monthlyLimit: 1_000, monthlyUsed: 800, rewardBalance: 1_000, subsidiaryOver: false,
    })).toEqual({ monthly: 200, reward: 300 });
  });

  it("does not touch the reward balance while the monthly allowance still covers the delta", () => {
    expect(allocateConsumption({
      delta: 200, monthlyLimit: 1_000, monthlyUsed: 800, rewardBalance: 1_000, subsidiaryOver: false,
    })).toEqual({ monthly: 200, reward: 0 });
  });

  it("never debits more reward than the balance; the overflow of a running session lands in monthly usage", () => {
    expect(allocateConsumption({
      delta: 900, monthlyLimit: 1_000, monthlyUsed: 1_000, rewardBalance: 250, subsidiaryOver: false,
    })).toEqual({ monthly: 650, reward: 250 });
  });

  it("treats a monthly limit of 0 as unlimited and leaves the reward balance alone", () => {
    expect(allocateConsumption({
      delta: 5_000_000, monthlyLimit: 0, monthlyUsed: 9_000_000, rewardBalance: 300_000, subsidiaryOver: false,
    })).toEqual({ monthly: 5_000_000, reward: 0 });
  });

  it("draws from the reward balance while the subsidiary cap is exceeded, even with monthly allowance left", () => {
    expect(allocateConsumption({
      delta: 400, monthlyLimit: 10_000, monthlyUsed: 0, rewardBalance: 300, subsidiaryOver: true,
    })).toEqual({ monthly: 100, reward: 300 });
  });

  it.each([0, -5, Number.NaN])("counts nothing for a non-positive delta (%s)", (delta) => {
    expect(allocateConsumption({
      delta, monthlyLimit: 100, monthlyUsed: 100, rewardBalance: 100, subsidiaryOver: false,
    })).toEqual({ monthly: 0, reward: 0 });
  });
});

describe("consumptionDelta (CC-PBUDGET-INV-05)", () => {
  it("returns the positive difference of cumulative tokens", () => {
    expect(consumptionDelta(1_000, 1_750)).toBe(750);
  });

  it("returns 0 when the cumulative total did not grow or went backwards", () => {
    expect(consumptionDelta(1_000, 1_000)).toBe(0);
    expect(consumptionDelta(1_000, 400)).toBe(0);
  });
});

describe("initialBaseline", () => {
  it("counts a session that started after the person was enrolled from zero", () => {
    expect(initialBaseline({ sessionStartedAtMs: 2_000, personCreatedAtMs: 1_000, total: 900 })).toBe(0);
  });

  it("does not bill tokens a session had already used before the person was enrolled", () => {
    expect(initialBaseline({ sessionStartedAtMs: 500, personCreatedAtMs: 1_000, total: 900 })).toBe(900);
  });
});

describe("localMonth", () => {
  it("formats the local month so the monthly allowance resets at the start of the local month", () => {
    expect(localMonth(new Date(2026, 9, 2, 12).getTime())).toBe("2026-10");
    expect(localMonth(new Date(2027, 0, 1, 0, 0, 1).getTime())).toBe("2027-01");
  });
});
