import { describe, expect, it } from "vitest";
import { resolveBudgetPerson } from "./person-resolution.js";
import { consumptionSessionOf } from "./session-facts.js";

describe("resolveBudgetPerson (CC-PBUDGET-INV-07)", () => {
  it("identifies a subsidiary member by company, platform and user id", () => {
    expect(resolveBudgetPerson({ subsidiaryId: " glab ", platform: "discord", platformUserId: " 12345 " }))
      .toEqual({ ok: true, identity: { subsidiaryId: "glab", platform: "discord", platformUserId: "12345" } });
  });

  it("excludes head-office members, who have no company", () => {
    expect(resolveBudgetPerson({ subsidiaryId: null, platform: "discord", platformUserId: "12345" }))
      .toEqual({ ok: false, reason: "head_office" });
  });

  it("excludes sessions without a requester", () => {
    expect(resolveBudgetPerson({ subsidiaryId: "glab", platform: null, platformUserId: null }))
      .toEqual({ ok: false, reason: "no_requester" });
    expect(resolveBudgetPerson({ subsidiaryId: "glab", platform: "discord", platformUserId: "  " }))
      .toEqual({ ok: false, reason: "no_requester" });
  });

  it("rejects a user id that cannot be a platform id", () => {
    expect(resolveBudgetPerson({ subsidiaryId: "glab", platform: "discord", platformUserId: "a b" }))
      .toEqual({ ok: false, reason: "invalid_identity" });
  });
});

describe("consumptionSessionOf", () => {
  it("reads the company and the requester from session metadata", () => {
    expect(consumptionSessionOf({
      id: "s1", started_at: 1_700_000_000,
      metadata: JSON.stringify({ subsidiary_id: "glab", discord_requester_user_id: "12345" }),
    })).toEqual({
      id: "s1", subsidiaryId: "glab", requesterPlatform: "discord", requesterUserId: "12345", startedAtMs: 1_700_000_000_000,
    });
  });

  it("treats missing or broken metadata as a session without a requester", () => {
    for (const metadata of [null, "{broken", JSON.stringify(["x"]), JSON.stringify({ subsidiary_id: "glab" })]) {
      const facts = consumptionSessionOf({ id: "s1", started_at: 1, metadata });
      expect(facts.requesterUserId).toBeNull();
      expect(facts.requesterPlatform).toBeNull();
    }
  });
});
