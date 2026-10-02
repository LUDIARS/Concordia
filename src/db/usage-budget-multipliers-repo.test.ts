import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { UsageBudgetMultipliersRepo } from "./usage-budget-multipliers-repo.js";

describe("UsageBudgetMultipliersRepo", () => {
  it("役職ごとの倍率を保存・更新・削除し、 範囲外は DB が拒む", () => {
    const repo = new UsageBudgetMultipliersRepo(makeTestDb());
    expect(repo.find("staff")).toBeNull();
    repo.upsert({ role: "staff", multiplier: 0.5, updated_by: "900" }, 1);
    expect(repo.upsert({ role: "staff", multiplier: 2, updated_by: null }, 2)).toMatchObject({ role: "staff", multiplier: 2, updated_at: 2 });
    expect(repo.list()).toHaveLength(1);
    expect(() => repo.upsert({ role: "manager", multiplier: 0, updated_by: null })).toThrow();
    expect(repo.remove("staff")).toBe(true);
    expect(repo.remove("staff")).toBe(false);
  });
});
