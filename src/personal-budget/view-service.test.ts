import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { createPersonalBudget, type PersonalBudgetServices } from "./composition.js";
import { describeLedgerEntry, formatTokens, renderBudgetView, renderLedgerNotice } from "./format.js";
import { effectiveMonthlyLimit } from "./ports.js";
import { localMonth } from "./types.js";

let budget: PersonalBudgetServices;
const defaults = new Map<string, number>();
const companyName = (id: string): string => ({ glab: "GLAB", vantan: "Vantan" }[id] ?? id);

beforeEach(() => {
  defaults.clear();
  budget = createPersonalBudget({
    db: makeTestDb(),
    subsidiaryMonthlyDefault: (id) => defaults.get(id) ?? null,
    isGlobalOver: () => false,
    readSetting: () => null,
  });
});

describe("effectiveMonthlyLimit", () => {
  it("prefers the personal override, then the subsidiary default, then no limit", () => {
    expect(effectiveMonthlyLimit(5_000, 1_000)).toBe(5_000);
    expect(effectiveMonthlyLimit(0, 1_000)).toBe(0);
    expect(effectiveMonthlyLimit(null, 1_000)).toBe(1_000);
    expect(effectiveMonthlyLimit(null, null)).toBe(0);
    expect(effectiveMonthlyLimit(null, undefined)).toBe(0);
  });
});

describe("PersonalBudgetView (SPEC-PBUDGET-VIEW)", () => {
  it("summarizes this month's allowance, the reward balance and recent history", () => {
    defaults.set("glab", 1_000_000);
    const person = budget.people.ensure({ subsidiaryId: "glab", platform: "discord", platformUserId: "111" }, "alice");
    budget.usage.applyConsumption({
      sessionId: "s1", personId: person.id, period: localMonth(Date.now()), total: 250_000,
      plan: () => ({ delta: 250_000, baseline: 0, monthly: 250_000, reward: 0 }),
    });
    budget.ledger.grant({ personId: person.id, kind: "tabula", sourceRef: "pub-1", tokens: 300_000 });

    const [view] = budget.view.forUser({ platform: "discord", platformUserId: "111", subsidiaryId: "glab" });
    expect(view).toMatchObject({
      monthlyLimit: 1_000_000, monthlyUsed: 250_000, monthlyRemaining: 750_000, rewardBalance: 300_000,
    });
    expect(view!.recent).toHaveLength(1);

    const text = renderBudgetView([view!], companyName);
    expect(text).toContain("GLAB");
    expect(text).toContain("上限 1,000,000 / 使用 250,000 / 残り 750,000");
    expect(text).toContain("報酬分の残り: 300,000");
    expect(text).toContain("+300,000 Tabula 公開の報奨");
  });

  it("shows an unlimited monthly allowance without a remaining figure", () => {
    const person = budget.people.ensure({ subsidiaryId: "glab", platform: "discord", platformUserId: "111" });
    const summary = budget.view.summarize(person);
    expect(summary).toMatchObject({ monthlyLimit: 0, monthlyRemaining: null });
    expect(renderBudgetView([{ ...summary, recent: [] }], companyName)).toContain("上限なし / 使用 0");
  });

  it("lists every company of the same user when no company is given, and never creates rows by looking", () => {
    budget.people.ensure({ subsidiaryId: "glab", platform: "discord", platformUserId: "111" });
    budget.people.ensure({ subsidiaryId: "vantan", platform: "discord", platformUserId: "111" });
    expect(budget.view.forUser({ platform: "discord", platformUserId: "111" }).map((view) => view.person.subsidiary_id))
      .toEqual(["glab", "vantan"]);

    expect(budget.view.forUser({ platform: "discord", platformUserId: "999", subsidiaryId: "glab" })).toEqual([]);
    expect(budget.people.list({ limit: 10, offset: 0 }).total).toBe(2);
    expect(renderBudgetView([], companyName)).toContain("本社メンバーは対象外");
  });

  it("keeps only the latest five ledger entries in the personal view", () => {
    const person = budget.people.ensure({ subsidiaryId: "glab", platform: "discord", platformUserId: "111" });
    for (let i = 0; i < 7; i += 1) {
      budget.ledger.grant({ personId: person.id, kind: "bounty", sourceRef: `bug-${i}`, tokens: 10, now: 1_000 + i });
    }
    const [view] = budget.view.forUser({ platform: "discord", platformUserId: "111", subsidiaryId: "glab" });
    expect(view!.recent.map((entry) => entry.source_ref)).toEqual(["bug-6", "bug-5", "bug-4", "bug-3", "bug-2"]);
  });
});

describe("format", () => {
  const entry = {
    id: "pbl_1", person_id: "pbp_1", reward_kind: null, source_ref: null, session_id: null, period: null,
    actor: null, reason: null, notify_state: "pending" as const, notify_attempts: 0, created_at: 0,
  };

  it("describes ledger entries with a signed amount", () => {
    expect(formatTokens(1234567.9)).toBe("1,234,567");
    expect(describeLedgerEntry({ ...entry, entry_type: "debit", tokens: -400, period: "2026-10" })).toBe("-400 消費 (2026-10)");
    expect(describeLedgerEntry({ ...entry, entry_type: "manual", tokens: -300, reward_kind: "manual", reason: "訂正" }))
      .toBe("-300 本社の調整: 訂正");
    expect(describeLedgerEntry({ ...entry, entry_type: "revoke", tokens: -100, reward_kind: "bounty", reason: "判定が覆った" }))
      .toBe("-100 バグ報告の報奨の取り消し: 判定が覆った");
  });

  it("renders a notice for grants and adjustments but not for consumption", () => {
    const notice = renderLedgerNotice(
      { ...entry, entry_type: "manual", tokens: 500_000, reward_kind: "manual", reason: "勉強会の登壇" },
      { companyName: "GLAB", rewardBalance: 800_000 },
    );
    expect(notice).toContain("GLAB");
    expect(notice).toContain("+500,000 本社の調整: 勉強会の登壇");
    expect(notice).toContain("報酬分の残り: 800,000");
    expect(renderLedgerNotice({ ...entry, entry_type: "debit", tokens: -1, period: "2026-10" }, { companyName: "GLAB", rewardBalance: 0 }))
      .toBeNull();
  });
});
