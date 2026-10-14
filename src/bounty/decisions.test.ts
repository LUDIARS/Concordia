import { describe, expect, it } from "vitest";
import fixContract from "./fix-policy.contract.js";
import { bountyFixBranch, decideBountyHotfix, parseBountyHotfixDailyLimit, type BountyHotfixInput } from "./fix-policy.js";
import publicContract from "./public-view.contract.js";
import { decideBountyPublication, toBountyPublicReport } from "./public-view.js";
import rewardContract from "./reward-decision.contract.js";
import { bountyRewardIneligibility, decideBountyRewardRequest } from "./reward-decision.js";
import operatorContract from "./operator-auth.contract.js";
import { verifyBountyOperator } from "./operator-auth.js";

describe("decideBountyHotfix (bug-bounty.md §6 SPEC-BOUNTY-HOTFIX)", () => {
  const ready: BountyHotfixInput = {
    status: "fix_pending", verdict: "accepted", hotfixEligible: true, revisorWorkflow: "revisor",
    actioTaskRef: "actio:t1", hotfixStartedAt: null, hotfixesToday: 4, dailyLimit: 5,
  };
  it("starts only when every condition holds", () => {
    expect(decideBountyHotfix(ready)).toEqual({ ok: true });
    expect(fixContract.post(decideBountyHotfix(ready), ready)).toBe(true);
    const cases: Array<[Partial<BountyHotfixInput>, string]> = [
      [{ verdict: "rejected" }, "not_accepted"],
      [{ hotfixEligible: false }, "not_eligible"],
      [{ revisorWorkflow: "github" }, "not_revisor_workflow"],
      [{ actioTaskRef: null }, "task_missing"],
      [{ status: "fixing" }, "not_fix_pending"],
      [{ hotfixStartedAt: 10 }, "already_started"],
      [{ hotfixesToday: 5 }, "daily_limit"],
    ];
    for (const [patch, denial] of cases) {
      const input: BountyHotfixInput = { ...ready, ...patch };
      const result = decideBountyHotfix(input);
      expect(result).toEqual({ ok: false, denial });
      expect(fixContract.post(result, input)).toBe(true);
    }
  });
  it("parses the daily limit and names the fix branch", () => {
    expect(parseBountyHotfixDailyLimit(null)).toBe(5);
    expect(parseBountyHotfixDailyLimit("0")).toBe(0);
    expect(parseBountyHotfixDailyLimit("-1")).toBe(5);
    expect(bountyFixBranch("br_0123456789abcdef")).toBe("fix/bounty-0123456789");
  });
});

describe("decideBountyRewardRequest (bug-bounty.md §7, CC-BOUNTY-INV-05)", () => {
  const eligible = { verdict: "accepted", duplicateOf: null, selfInflicted: false, recipient: { subsidiaryId: "sub_a" } };
  it("requests only for accepted, non-duplicate, not self-inflicted reports with a non-HQ recipient", () => {
    expect(decideBountyRewardRequest(eligible)).toEqual({ request: true });
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ verdict: "rejected" }, "not_accepted"],
      [{ verdict: "duplicate", duplicateOf: "br_root" }, "duplicate"],
      [{ selfInflicted: true }, "self_inflicted"],
      [{ recipient: null }, "no_recipient"],
      [{ recipient: { subsidiaryId: null } }, "headquarters"],
    ];
    for (const [patch, reason] of cases) {
      const input = { ...eligible, ...patch } as typeof eligible;
      const result = decideBountyRewardRequest(input);
      expect(result).toEqual({ request: false, reason });
      expect(rewardContract.post(result, input)).toBe(true);
    }
    expect(bountyRewardIneligibility({ subsidiaryId: null })).toBe("headquarters");
    expect(bountyRewardIneligibility({ subsidiaryId: "sub_a" })).toBeNull();
  });
});

describe("decideBountyPublication (bug-bounty.md §8, CC-BOUNTY-INV-07)", () => {
  it("publishes accepted reports of public projects, sensitive ones only after deployment", () => {
    const cases: Array<[Parameters<typeof decideBountyPublication>[0], boolean]> = [
      [{ projectPublic: true, verdict: "accepted", status: "fix_pending", sensitive: false }, true],
      [{ projectPublic: true, verdict: "accepted", status: "fix_pending", sensitive: true }, false],
      [{ projectPublic: true, verdict: "accepted", status: "deployed", sensitive: true }, true],
      [{ projectPublic: false, verdict: "accepted", status: "deployed", sensitive: false }, false],
      [{ projectPublic: null, verdict: "accepted", status: "deployed", sensitive: false }, false],
      [{ projectPublic: true, verdict: "rejected", status: "rejected", sensitive: false }, false],
    ];
    for (const [input, expected] of cases) {
      const result = decideBountyPublication(input);
      expect(result).toBe(expected);
      expect(publicContract.post(result, input)).toBe(true);
    }
  });
  it("projects only the §8 fields", () => {
    const view = toBountyPublicReport({
      id: "br_1", project_code: "Cc", public_title: "題名", public_summary: "要約", severity: "s3", status: "deployed",
      received_at: 1, deployed_at: 2, reward_tokens: 500,
    }, "neco");
    expect(Object.keys(view).sort()).toEqual([
      "actio_source_ref", "deployed_at", "project", "received_at", "report_id", "reporter", "reward_tokens", "severity",
      "status", "summary", "title",
    ]);
  });
});

describe("verifyBountyOperator (CC-BOUNTY-INV-10)", () => {
  it("passes each route only with its own configured key", () => {
    const keys = { botToken: "bot", cocoiruKey: "coco-key" };
    const cases: Array<[Parameters<typeof verifyBountyOperator>[0], boolean]> = [
      [{ platform: "discord", provided: "bot", ...keys }, true],
      [{ platform: "discord", provided: "coco-key", ...keys }, false],
      [{ platform: "cocoiru", provided: "coco-key", ...keys }, true],
      [{ platform: "cocoiru", provided: "bot", ...keys }, false],
      [{ platform: "cocoiru", provided: "", ...keys, cocoiruKey: "" }, false],
      [{ platform: "cocoiru", provided: "x", botToken: "bot", cocoiruKey: null }, false],
      [{ platform: "discord", provided: null, ...keys }, false],
    ];
    for (const [input, expected] of cases) {
      const result = verifyBountyOperator(input);
      expect(result).toBe(expected);
      expect(operatorContract.post(result, input)).toBe(true);
    }
  });
});
