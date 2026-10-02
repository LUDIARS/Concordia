import { describe, expect, it } from "vitest";
import { chargedTokens, departmentCostMultiplier, isValidCostMultiplier } from "./budget-multiplier.js";

describe("chargedTokens", () => {
  it("本来のトークン × 部署の倍率 × 属性の倍率で予算から引く額にする", () => {
    expect(chargedTokens(1_000, 0.25, 1)).toBe(250);
    expect(chargedTokens(1_000, 0.25, 2)).toBe(500);
    expect(chargedTokens(1_000, 1, 1)).toBe(1_000);
  });

  it("範囲外の倍率は 1 として扱い、 負のトークンは 0 にする", () => {
    expect(chargedTokens(1_000, 0, 1)).toBe(1_000);
    expect(chargedTokens(1_000, 11, Number.NaN)).toBe(1_000);
    expect(chargedTokens(-5, 2, 2)).toBe(0);
    expect(isValidCostMultiplier(10)).toBe(true);
    expect(isValidCostMultiplier(0)).toBe(false);
  });
});

describe("departmentCostMultiplier", () => {
  it("部署設定の budget.cost_multiplier を使い、 無い・壊れていれば 1", () => {
    expect(departmentCostMultiplier(JSON.stringify({ budget: { cost_multiplier: 0.25 } }))).toBe(0.25);
    expect(departmentCostMultiplier(JSON.stringify({}))).toBe(1);
    expect(departmentCostMultiplier("{broken")).toBe(1);
    expect(departmentCostMultiplier(null)).toBe(1);
  });
});
