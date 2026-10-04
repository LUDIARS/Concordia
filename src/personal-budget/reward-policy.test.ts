import { describe, expect, it } from "vitest";
import { decideReward, REWARD_SETTINGS, revokeTokens, rewardTier, rewardTokens } from "./reward-policy.js";
import type { PersonResolution } from "./person-resolution.js";

const member: PersonResolution = { ok: true, identity: { subsidiaryId: "glab", platform: "discord", platformUserId: "111" } };

describe("rewardTier / rewardTokens (spec §5)", () => {
  it("maps kinds to the configured tiers with the proposed defaults", () => {
    expect(rewardTier("tabula")).toBe("tabula");
    expect(rewardTier("bounty", "s2")).toBe("bounty.s2");
    expect(rewardTier("bounty")).toBeNull();
    expect(rewardTokens("bounty.s1", null)).toBe(2_000_000);
    expect(rewardTokens("bounty.s4", "")).toBe(100_000);
    expect(rewardTokens("tabula", undefined)).toBe(300_000);
  });

  it("uses the configured amount, respects 0 and falls back on unreadable values", () => {
    expect(rewardTokens("tabula", "450000")).toBe(450_000);
    expect(rewardTokens("tabula", "0")).toBe(0);
    expect(rewardTokens("tabula", "-1")).toBe(300_000);
    expect(rewardTokens("tabula", "many")).toBe(300_000);
  });

  it("keeps the setting keys the spec names, and has no consultation reward", () => {
    expect(Object.values(REWARD_SETTINGS).map((setting) => setting.key)).toEqual([
      "personal_budget.reward.bounty.s1",
      "personal_budget.reward.bounty.s2",
      "personal_budget.reward.bounty.s3",
      "personal_budget.reward.bounty.s4",
      "personal_budget.reward.tabula",
    ]);
  });
});

describe("decideReward (CC-PBUDGET-INV-04 / 07)", () => {
  it("grants the configured amount to a subsidiary member", () => {
    expect(decideReward({ kind: "tabula", sourceRef: "pub-1", recipient: member, tokens: 300_000, alreadyGranted: null }))
      .toEqual({ action: "grant", identity: member.ok ? member.identity : null, tokens: 300_000 });
  });

  it("returns the existing grant for a repeated source instead of granting twice", () => {
    expect(decideReward({ kind: "tabula", sourceRef: "pub-1", recipient: member, tokens: 999_999, alreadyGranted: 300_000 }))
      .toEqual({ action: "existing", tokens: 300_000 });
  });

  it("does not grant to head-office members or unidentified recipients, and says why", () => {
    expect(decideReward({
      kind: "bounty", sourceRef: "bug-1", recipient: { ok: false, reason: "head_office" }, tokens: 1_000, alreadyGranted: null,
    })).toEqual({ action: "skip", reason: "head_office" });
    expect(decideReward({
      kind: "bounty", sourceRef: "bug-1", recipient: { ok: false, reason: "no_requester" }, tokens: 1_000, alreadyGranted: null,
    })).toEqual({ action: "skip", reason: "no_requester" });
  });

  it("skips an invalid source, an unknown tier and a zero amount", () => {
    expect(decideReward({ kind: "tabula", sourceRef: "", recipient: member, tokens: 1, alreadyGranted: null }))
      .toEqual({ action: "skip", reason: "invalid_source" });
    expect(decideReward({ kind: "bounty", sourceRef: "bug-1", recipient: member, tokens: null, alreadyGranted: null }))
      .toEqual({ action: "skip", reason: "unknown_tier" });
    expect(decideReward({ kind: "tabula", sourceRef: "pub-1", recipient: member, tokens: 0, alreadyGranted: null }))
      .toEqual({ action: "skip", reason: "zero_amount" });
  });
});

describe("revokeTokens", () => {
  it("revokes at most the unused part of the grant", () => {
    expect(revokeTokens({ grantedTokens: 500, rewardBalance: 800 })).toBe(500);
    expect(revokeTokens({ grantedTokens: 500, rewardBalance: 120 })).toBe(120);
    expect(revokeTokens({ grantedTokens: 500, rewardBalance: 0 })).toBe(0);
  });
});
