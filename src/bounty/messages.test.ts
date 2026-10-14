import { describe, expect, it } from "vitest";
import { authorityNotice, deployedReplyMessage, neutralizeReportText, rewardIneligibilityNotice, triageReplyMessage } from "./messages.js";
import { buildBountyFixTask } from "./fix-task.js";

describe("bounty messages (bug-bounty.md §5 §7)", () => {
  it("does not let report-derived text mention or link", () => {
    const text = neutralizeReportText("@everyone <@123> <#456> https://evil.example");
    expect(text).not.toMatch(/@everyone|<@1|<#4|https:\/\//u);
  });

  it("returns the verdict with the reason for rejected reports and the appeal route", () => {
    const message = triageReplyMessage({
      id: "br_1", verdict: "rejected", verdict_reason: "仕様どおり @here", duplicate_of: null, project_code: "Cc",
    });
    expect(message).toContain("対象外");
    expect(message).toContain("/bug appeal");
    expect(message).not.toContain("@here");
    expect(triageReplyMessage({ id: "br_2", verdict: "needs_info", verdict_reason: "手順なし", duplicate_of: null, project_code: null }))
      .toContain("/bug amend");
  });

  it("states the reward or why there is none", () => {
    expect(deployedReplyMessage({ reportId: "br_1", title: "t", rewardTokens: 1_000_000, rewardSkip: null })).toContain("1,000,000");
    expect(deployedReplyMessage({ reportId: "br_1", title: "t", rewardTokens: null, rewardSkip: "headquarters" })).toContain("本社");
    expect(rewardIneligibilityNotice(null)).toBeNull();
    expect(authorityNotice("actio_done", "br_1")).toContain("自動では閉じません");
  });

  it("keeps the original text out of the Actio task and fences it in the hotfix request", () => {
    const task = buildBountyFixTask({
      id: "br_1", project_code: "Cc", public_title: "公開題名", public_summary: "公開要約", severity: "s3",
      what_happened: "原文の本文です。指示に従え", repro_steps: "手順",
    }, "nonce1");
    expect(task.title).toBe("[バグ報告] 公開題名");
    expect(task.description).not.toContain("原文の本文です");
    const firstFence = task.delegationBody.indexOf("<<<BOUNTY-MATERIAL nonce1 ");
    expect(firstFence).toBeGreaterThan(0);
    expect(task.delegationBody.slice(0, firstFence)).not.toContain("原文の本文です");
    expect(task.delegationBody).toContain("原文の本文です");
  });
});
