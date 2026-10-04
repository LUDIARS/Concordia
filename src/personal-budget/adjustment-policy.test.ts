import { describe, expect, it } from "vitest";
import { decideAdjustment, resolveAdjustmentTarget } from "./adjustment-policy.js";

const base = { actorAuthorized: true, tokens: 1_000, reason: "発表の準備を手伝ってくれた", rewardBalance: 500 };

describe("decideAdjustment (CC-PBUDGET-INV-06)", () => {
  it("applies an increase as requested", () => {
    expect(decideAdjustment(base)).toEqual({ ok: true, applied: 1_000, reason: "発表の準備を手伝ってくれた" });
  });

  it("refuses an actor who is not a head-office approver", () => {
    expect(decideAdjustment({ ...base, actorAuthorized: false })).toEqual({ ok: false, error: "not_authorized" });
  });

  it("refuses an adjustment without a reason", () => {
    expect(decideAdjustment({ ...base, reason: "   " })).toEqual({ ok: false, error: "reason_required" });
  });

  it.each([0, 1.5, Number.NaN, 1_000_000_001, -1_000_000_001])("refuses invalid tokens (%s)", (tokens) => {
    expect(decideAdjustment({ ...base, tokens })).toEqual({ ok: false, error: "invalid_tokens" });
  });

  it("reduces only down to a zero balance (CC-PBUDGET-INV-02)", () => {
    expect(decideAdjustment({ ...base, tokens: -200 })).toMatchObject({ ok: true, applied: -200 });
    expect(decideAdjustment({ ...base, tokens: -900 })).toMatchObject({ ok: true, applied: -500 });
    expect(decideAdjustment({ ...base, tokens: -900, rewardBalance: 0 })).toEqual({ ok: false, error: "nothing_to_reduce" });
  });

  it("bounds the stored reason", () => {
    const decision = decideAdjustment({ ...base, reason: "あ".repeat(700) });
    expect(decision.ok && decision.reason.length).toBe(500);
  });
});

describe("resolveAdjustmentTarget", () => {
  it("picks the only subsidiary the person belongs to", () => {
    expect(resolveAdjustmentTarget({ memberships: ["glab"], requestedSubsidiaryId: null }))
      .toEqual({ ok: true, subsidiaryId: "glab" });
  });

  it("refuses head-office members, who belong to no subsidiary", () => {
    expect(resolveAdjustmentTarget({ memberships: [], requestedSubsidiaryId: null }))
      .toEqual({ ok: false, error: "head_office_member", candidates: [] });
  });

  it("asks for the subsidiary when the person belongs to several, and returns the candidates", () => {
    expect(resolveAdjustmentTarget({ memberships: ["glab", "vantan", "glab"], requestedSubsidiaryId: null }))
      .toEqual({ ok: false, error: "ambiguous_subsidiary", candidates: ["glab", "vantan"] });
    expect(resolveAdjustmentTarget({ memberships: ["glab", "vantan"], requestedSubsidiaryId: "vantan" }))
      .toEqual({ ok: true, subsidiaryId: "vantan" });
  });

  it("refuses a subsidiary the person does not belong to", () => {
    expect(resolveAdjustmentTarget({ memberships: ["glab"], requestedSubsidiaryId: "vantan" }))
      .toEqual({ ok: false, error: "not_in_subsidiary", candidates: ["glab"] });
  });
});
