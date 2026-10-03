import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { UsageBudgetMultipliersRepo } from "./usage-budget-multipliers-repo.js";

describe("UsageBudgetMultipliersRepo", () => {
  it("Discord のロールごとの倍率を保存・更新・削除し、 範囲外は DB が拒む", () => {
    const repo = new UsageBudgetMultipliersRepo(makeTestDb());
    expect(repo.find("111111")).toBeNull();
    repo.upsert({ role_id: "111111", guild_id: "900000", multiplier: 0.5, updated_by: "900" }, 1);
    expect(repo.upsert({ role_id: "111111", guild_id: "900000", multiplier: 2, updated_by: null }, 2))
      .toMatchObject({ role_id: "111111", guild_id: "900000", multiplier: 2, updated_at: 2 });
    expect(repo.list()).toHaveLength(1);
    expect(() => repo.upsert({ role_id: "222222", guild_id: "900000", multiplier: 0, updated_by: null })).toThrow();
    expect(repo.remove("111111")).toBe(true);
    expect(repo.remove("111111")).toBe(false);
  });

  it("数字でないロール id・guild id は DB が拒む (旧来の役職名を入れない)", () => {
    const repo = new UsageBudgetMultipliersRepo(makeTestDb());
    expect(() => repo.upsert({ role_id: "staff", guild_id: "900000", multiplier: 1, updated_by: null })).toThrow();
    expect(() => repo.upsert({ role_id: "111111", guild_id: "guild", multiplier: 1, updated_by: null })).toThrow();
  });
});
