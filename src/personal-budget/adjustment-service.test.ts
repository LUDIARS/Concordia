import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { createPersonalBudget, type PersonalBudgetServices } from "./composition.js";

let budget: PersonalBudgetServices;

const approver = { id: "discord:900", authorized: true };
const byUser = (memberships: string[], requestedSubsidiaryId: string | null = null) => ({
  platform: "discord" as const, platformUserId: "111", displayName: "alice", memberships, requestedSubsidiaryId,
});

beforeEach(() => {
  budget = createPersonalBudget({
    db: makeTestDb(),
    subsidiaryMonthlyDefault: () => 0,
    isGlobalOver: () => false,
    readSetting: () => null,
  });
});

describe("PersonalBudgetAdjustments.adjust (SPEC-PBUDGET-ADJUST)", () => {
  it("records who adjusted whom, by how much and why, and queues a notice (CC-PBUDGET-INV-06)", () => {
    const outcome = budget.adjustments.adjust({
      actor: approver, target: byUser(["glab"]), tokens: 500_000, reason: "勉強会の登壇",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.person).toMatchObject({ subsidiary_id: "glab", platform_user_id: "111", display_name: "alice" });
    expect(outcome.entry).toMatchObject({
      entry_type: "manual", reward_kind: "manual", tokens: 500_000, actor: "discord:900", reason: "勉強会の登壇",
      notify_state: "pending",
    });
    expect(outcome.entry.source_ref).toBe(outcome.entry.id);
    expect(outcome.rewardBalance).toBe(500_000);
  });

  it("refuses an unauthorized actor before creating a person row", () => {
    const outcome = budget.adjustments.adjust({
      actor: { id: "discord:1", authorized: false }, target: byUser(["glab"]), tokens: 100, reason: "x",
    });
    expect(outcome).toMatchObject({ ok: false, error: "not_authorized" });
    expect(budget.people.list({ limit: 10, offset: 0 }).total).toBe(0);
  });

  it("refuses an adjustment without a reason", () => {
    expect(budget.adjustments.adjust({ actor: approver, target: byUser(["glab"]), tokens: 100, reason: " " }))
      .toMatchObject({ ok: false, error: "reason_required" });
    expect(budget.people.list({ limit: 10, offset: 0 }).total).toBe(0);
  });

  it("refuses head-office members and returns the reason", () => {
    const outcome = budget.adjustments.adjust({ actor: approver, target: byUser([]), tokens: 100, reason: "お礼" });
    expect(outcome).toMatchObject({ ok: false, error: "head_office_member" });
    expect(!outcome.ok && outcome.message).toContain("本社メンバー");
  });

  it("asks for the subsidiary when the person belongs to several, without adjusting anything", () => {
    const outcome = budget.adjustments.adjust({ actor: approver, target: byUser(["glab", "vantan"]), tokens: 100, reason: "お礼" });
    expect(outcome).toMatchObject({ ok: false, error: "ambiguous_subsidiary", candidates: ["glab", "vantan"] });
    expect(budget.people.list({ limit: 10, offset: 0 }).total).toBe(0);

    const chosen = budget.adjustments.adjust({ actor: approver, target: byUser(["glab", "vantan"], "vantan"), tokens: 100, reason: "お礼" });
    expect(chosen.ok && chosen.person.subsidiary_id).toBe("vantan");
  });

  it("reduces only down to zero and refuses a reduction on an empty balance", () => {
    budget.adjustments.adjust({ actor: approver, target: byUser(["glab"]), tokens: 300, reason: "付与" });
    const reduced = budget.adjustments.adjust({ actor: approver, target: byUser(["glab"]), tokens: -1_000, reason: "誤付与の訂正" });
    expect(reduced.ok && reduced.entry.tokens).toBe(-300);
    expect(reduced.ok && reduced.rewardBalance).toBe(0);

    const again = budget.adjustments.adjust({ actor: approver, target: byUser(["glab"]), tokens: -1, reason: "さらに減額" });
    expect(again).toMatchObject({ ok: false, error: "nothing_to_reduce" });
  });

  it("adjusts an existing person by id (WebUI) and reports an unknown id", () => {
    const person = budget.people.ensure({ subsidiaryId: "glab", platform: "discord", platformUserId: "111" });
    const outcome = budget.adjustments.adjust({
      actor: { id: "webui", authorized: true }, target: { personId: person.id }, tokens: 42, reason: "検証",
    });
    expect(outcome.ok && outcome.entry.actor).toBe("webui");
    expect(budget.adjustments.adjust({
      actor: { id: "webui", authorized: true }, target: { personId: "pbp_missing" }, tokens: 42, reason: "検証",
    })).toMatchObject({ ok: false, error: "person_not_found" });
  });
});
