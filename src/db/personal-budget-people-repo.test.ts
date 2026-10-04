import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { PersonalBudgetPeopleRepo } from "./personal-budget-people-repo.js";
import { SubsidiaryRepo } from "./subsidiary-repo.js";

const identity = { subsidiaryId: "glab", platform: "discord" as const, platformUserId: "111" };

describe("PersonalBudgetPeopleRepo", () => {
  it("keeps one row per company, platform and user, and fills an empty display name later", () => {
    const repo = new PersonalBudgetPeopleRepo(makeTestDb());
    const first = repo.ensure(identity, "", 1_000);
    expect(first).toMatchObject({ subsidiary_id: "glab", display_name: "", monthly_token_limit: null, created_at: 1_000 });

    const again = repo.ensure(identity, "alice", 2_000);
    expect(again.id).toBe(first.id);
    expect(again).toMatchObject({ display_name: "alice", created_at: 1_000 });
    // 人が見た表示名を後の投稿で上書きしない。
    expect(repo.ensure(identity, "bob", 3_000).display_name).toBe("alice");
    expect(repo.list({ limit: 10, offset: 0 }).total).toBe(1);
  });

  it("treats the same user in another company as another person", () => {
    const repo = new PersonalBudgetPeopleRepo(makeTestDb());
    const glab = repo.ensure(identity);
    const vantan = repo.ensure({ ...identity, subsidiaryId: "vantan" });
    expect(vantan.id).not.toBe(glab.id);
    expect(repo.listByUser("discord", "111").map((person) => person.subsidiary_id)).toEqual(["glab", "vantan"]);
    expect(repo.find({ ...identity, subsidiaryId: "nowhere" })).toBeNull();
  });

  it("stores, clears and bounds the monthly limit override", () => {
    const repo = new PersonalBudgetPeopleRepo(makeTestDb());
    const person = repo.ensure(identity);
    expect(repo.setMonthlyLimit(person.id, 250_000.9)?.monthly_token_limit).toBe(250_000);
    expect(repo.setMonthlyLimit(person.id, 0)?.monthly_token_limit).toBe(0);
    expect(repo.setMonthlyLimit(person.id, null)?.monthly_token_limit).toBeNull();
    expect(repo.setMonthlyLimit("pbp_missing", 1)).toBeNull();
  });

  it("pages the list and filters by company", () => {
    const repo = new PersonalBudgetPeopleRepo(makeTestDb());
    for (let i = 0; i < 5; i += 1) repo.ensure({ ...identity, platformUserId: `10${i}` }, `user-${i}`);
    repo.ensure({ subsidiaryId: "vantan", platform: "discord", platformUserId: "900" }, "zed");

    const firstPage = repo.list({ limit: 2, offset: 0 });
    expect(firstPage.total).toBe(6);
    expect(firstPage.people.map((person) => person.display_name)).toEqual(["user-0", "user-1"]);
    expect(repo.list({ limit: 2, offset: 4 }).people.map((person) => person.display_name)).toEqual(["user-4", "zed"]);
    expect(repo.list({ subsidiaryId: "vantan", limit: 10, offset: 0 })).toMatchObject({ total: 1 });
  });
});

describe("subsidiaries.personal_monthly_token_budget", () => {
  it("defaults to 0 (no limit) and is stored as a non-negative integer", () => {
    const repo = new SubsidiaryRepo(makeTestDb());
    const created = repo.create({ name: "glab", platform: "discord", enabled: true });
    expect(created.personal_monthly_token_budget).toBe(0);

    expect(repo.update(created.id, { personal_monthly_token_budget: 2_500_000.7 })?.personal_monthly_token_budget).toBe(2_500_000);
    // 他の項目の更新で消えない。
    expect(repo.update(created.id, { display_name: "GLAB" })?.personal_monthly_token_budget).toBe(2_500_000);
    expect(repo.update(created.id, { personal_monthly_token_budget: -5 })?.personal_monthly_token_budget).toBe(0);
    expect(repo.create({ name: "vantan", platform: "discord", enabled: true, personal_monthly_token_budget: 900 })
      .personal_monthly_token_budget).toBe(900);
  });
});
