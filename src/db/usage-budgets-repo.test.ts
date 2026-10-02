import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { UsageBudgetsRepo } from "./usage-budgets-repo.js";

describe("UsageBudgetsRepo", () => {
  it("sets, updates and removes a budget per scope and target", () => {
    const repo = new UsageBudgetsRepo(makeTestDb());
    expect(repo.find("user", "111")).toBeNull();
    repo.upsert({ scope: "user", target_id: "111", limit_tokens: 1_000, updated_by: "900" }, 1);
    repo.upsert({ scope: "user", target_id: "111", limit_tokens: 2_000, updated_by: "901" }, 2);
    repo.upsert({ scope: "team", target_id: "team_a", limit_tokens: 5_000, updated_by: null }, 3);
    expect(repo.find("user", "111")).toMatchObject({ limit_tokens: 2_000, updated_by: "901", updated_at: 2 });
    expect(repo.list().map((row) => `${row.scope}:${row.target_id}`)).toEqual(["team:team_a", "user:111"]);
    expect(repo.remove("user", "111")).toBe(true);
    expect(repo.remove("user", "111")).toBe(false);
  });

  it("claims each monthly threshold notice once and can release it for a retry", () => {
    const repo = new UsageBudgetsRepo(makeTestDb());
    expect(repo.claimNotice("user", "111", "2026-10", 80)).toBe(true);
    expect(repo.claimNotice("user", "111", "2026-10", 80)).toBe(false);
    expect(repo.claimNotice("user", "111", "2026-10", 100)).toBe(true);
    expect(repo.claimNotice("user", "111", "2026-11", 80)).toBe(true);
    repo.releaseNotice("user", "111", "2026-10", 80);
    expect(repo.claimNotice("user", "111", "2026-10", 80)).toBe(true);
  });
});
