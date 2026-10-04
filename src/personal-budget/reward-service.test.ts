import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { createPersonalBudget, type PersonalBudgetServices } from "./composition.js";

let budget: PersonalBudgetServices;
let settings: Map<string, string>;
let info: ReturnType<typeof vi.fn>;

const member = { subsidiaryId: "glab", platform: "discord" as const, platformUserId: "111", displayName: "alice" };

beforeEach(() => {
  settings = new Map();
  info = vi.fn();
  budget = createPersonalBudget({
    db: makeTestDb(),
    subsidiaryMonthlyDefault: () => 0,
    isGlobalOver: () => false,
    readSetting: (key) => settings.get(key) ?? null,
    log: { info, warn: vi.fn() },
  });
});

describe("PersonalBudgetRewards.requestReward (SPEC-PBUDGET-REWARD)", () => {
  it("grants the default amount for a published consultation and queues a notice for the recipient", () => {
    const outcome = budget.rewards.requestReward({ kind: "tabula", sourceRef: "pub-1", recipient: member });
    expect(outcome.status).toBe("granted");
    const person = budget.people.find({ subsidiaryId: "glab", platform: "discord", platformUserId: "111" })!;
    expect(budget.ledger.balance(person.id)).toBe(300_000);
    expect(outcome.status === "granted" && outcome.entry).toMatchObject({
      entry_type: "grant", reward_kind: "tabula", source_ref: "pub-1", tokens: 300_000, notify_state: "pending",
    });
  });

  it("grants a source only once, even when the configured amount changes in between (CC-PBUDGET-INV-04)", () => {
    budget.rewards.requestReward({ kind: "tabula", sourceRef: "pub-1", recipient: member });
    settings.set("personal_budget.reward.tabula", "900000");
    const again = budget.rewards.requestReward({ kind: "tabula", sourceRef: "pub-1", recipient: member });
    expect(again.status).toBe("existing");
    const person = budget.people.find({ subsidiaryId: "glab", platform: "discord", platformUserId: "111" })!;
    expect(budget.ledger.balance(person.id)).toBe(300_000);
    expect(budget.ledger.listForPerson(person.id, { limit: 10, offset: 0 }).total).toBe(1);
  });

  it("uses the configured amount per bounty severity", () => {
    settings.set("personal_budget.reward.bounty.s3", "123456");
    const outcome = budget.rewards.requestReward({ kind: "bounty", sourceRef: "bug-9", recipient: member, severity: "s3" });
    expect(outcome.status === "granted" && outcome.entry.tokens).toBe(123_456);
    const other = budget.rewards.requestReward({ kind: "bounty", sourceRef: "bug-10", recipient: member, severity: "s1" });
    expect(other.status === "granted" && other.entry.tokens).toBe(2_000_000);
  });

  it("does not grant to a head-office recipient or an unidentified one, and records why without creating a row", () => {
    const hq = budget.rewards.requestReward({ kind: "tabula", sourceRef: "pub-2", recipient: { ...member, subsidiaryId: null } });
    expect(hq).toMatchObject({ status: "skipped", reason: "head_office" });
    const unknown = budget.rewards.requestReward({
      kind: "tabula", sourceRef: "pub-3", recipient: { subsidiaryId: "glab", platform: null, platformUserId: null },
    });
    expect(unknown).toMatchObject({ status: "skipped", reason: "no_requester" });
    expect(budget.people.list({ limit: 10, offset: 0 }).total).toBe(0);
    expect(info).toHaveBeenCalledTimes(2);
    expect(String(info.mock.calls[0]?.[0])).toContain("reason=head_office");
  });

  it("skips a bounty without a severity instead of guessing an amount", () => {
    expect(budget.rewards.requestReward({ kind: "bounty", sourceRef: "bug-1", recipient: member }))
      .toMatchObject({ status: "skipped", reason: "unknown_tier" });
  });
});

describe("PersonalBudgetRewards.revokeReward", () => {
  it("revokes the unused part of a grant once", () => {
    budget.rewards.requestReward({ kind: "tabula", sourceRef: "pub-1", recipient: member });
    const person = budget.people.find({ subsidiaryId: "glab", platform: "discord", platformUserId: "111" })!;
    // 20 万を使った後に取り消す → 残り 10 万だけ引く。
    budget.usage.applyConsumption({
      sessionId: "s1", personId: person.id, period: "2026-10", total: 200_000,
      plan: () => ({ delta: 200_000, baseline: 0, monthly: 0, reward: 200_000 }),
    });
    const revoked = budget.rewards.revokeReward({ kind: "tabula", sourceRef: "pub-1", reason: "公開を取り下げた" });
    expect(revoked.status === "revoked" && revoked.entry).toMatchObject({ entry_type: "revoke", tokens: -100_000, reason: "公開を取り下げた" });
    expect(budget.ledger.balance(person.id)).toBe(0);

    expect(budget.rewards.revokeReward({ kind: "tabula", sourceRef: "pub-1", reason: "再送" }).status).toBe("existing");
    expect(budget.ledger.balance(person.id)).toBe(0);
  });

  it("reports a source that was never granted", () => {
    expect(budget.rewards.revokeReward({ kind: "bounty", sourceRef: "bug-404", reason: "判定が覆った" }))
      .toEqual({ status: "not_granted" });
  });
});
