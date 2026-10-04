import { describe, expect, it } from "vitest";
import {
  ANONYMOUS_PUBLIC_NAME,
  decideBountyWithdrawal,
  displayPublicName,
  normalizePublicName,
  resolveSessionRecipient,
} from "./reporter.js";

describe("normalizePublicName (bug-bounty.md §4)", () => {
  it("treats a blank name as unset", () => {
    expect(normalizePublicName("   ")).toEqual({ ok: true, name: null });
    expect(normalizePublicName(null)).toEqual({ ok: true, name: null });
  });

  it("keeps an ordinary name", () => {
    expect(normalizePublicName("  neco_dev  ")).toEqual({ ok: true, name: "neco_dev" });
    expect(normalizePublicName("ねこ")).toEqual({ ok: true, name: "ねこ" });
  });

  it.each(["@everyone", "<@123456>", "a\nb", "https://example.com", "`code`", "x".repeat(33)])(
    "refuses %j (mention, link, line break or too long)",
    (name) => {
      expect(normalizePublicName(name)).toEqual({ ok: false, error: "public_name_invalid" });
    },
  );
});

describe("displayPublicName", () => {
  it("shows 匿名 until the reporter chooses a name", () => {
    expect(displayPublicName({ kind: "person", publicName: null })).toBe(ANONYMOUS_PUBLIC_NAME);
    expect(displayPublicName({ kind: "person", publicName: "neco" })).toBe("neco");
  });

  it("shows a session report with its requester's public name", () => {
    expect(displayPublicName({ kind: "session", publicName: null })).toBe("AI セッション (依頼者: 匿名)");
    expect(displayPublicName({ kind: "session", publicName: "neco" })).toBe("AI セッション (依頼者: neco)");
  });
});

describe("resolveSessionRecipient (CC-BOUNTY-INV-05)", () => {
  it("names the session's requester with the session's company", () => {
    expect(resolveSessionRecipient({ requesterDiscordUserId: "905235114026467350", companyId: "sub_a" }))
      .toEqual({ companyId: "sub_a", platform: "discord", platformUserId: "905235114026467350" });
  });

  it("has no recipient when the requester cannot be identified", () => {
    expect(resolveSessionRecipient({ requesterDiscordUserId: null, companyId: null })).toBeNull();
    expect(resolveSessionRecipient({ requesterDiscordUserId: "  ", companyId: "sub_a" })).toBeNull();
    expect(resolveSessionRecipient({ requesterDiscordUserId: "not-a-snowflake", companyId: null })).toBeNull();
  });
});

describe("decideBountyWithdrawal (bug-bounty.md §9)", () => {
  const person = { kind: "person" as const, reporterId: "bp_1" };
  const session = { kind: "session" as const, sessionId: "sess-1" };

  it("lets the reporter withdraw before acceptance", () => {
    expect(decideBountyWithdrawal({ status: "received", reporter: person, actor: person })).toEqual({ ok: true });
    expect(decideBountyWithdrawal({ status: "needs_info", reporter: session, actor: session })).toEqual({ ok: true });
  });

  it("refuses anyone but the reporter", () => {
    expect(decideBountyWithdrawal({ status: "received", reporter: person, actor: { kind: "person", reporterId: "bp_2" } }))
      .toEqual({ ok: false, denial: "not_reporter" });
    // 同じ id 文字列でも、 人とセッションは別の主体。
    expect(decideBountyWithdrawal({ status: "received", reporter: session, actor: { kind: "person", reporterId: "sess-1" } }))
      .toEqual({ ok: false, denial: "not_reporter" });
  });

  it.each(["accepted", "rejected", "duplicate", "fix_pending", "fixing", "fix_submitted", "deployed", "withdrawn"] as const)(
    "refuses the reporter once the report is %s",
    (status) => {
      expect(decideBountyWithdrawal({ status, reporter: person, actor: person }))
        .toEqual({ ok: false, denial: "already_decided" });
    },
  );
});
