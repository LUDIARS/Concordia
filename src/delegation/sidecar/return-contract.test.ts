import { describe, expect, it } from "vitest";
import { reviewSidecarReturn } from "./return-contract.js";

const complete = {
  summary: "ラベルを修正",
  commits: ["abc1234"],
  verification_done: [],
  verification_skipped: ["vitest (許可なし)"],
  remaining: [],
  consumption: "Sol medium 1 run",
};

describe("reviewSidecarReturn", () => {
  it("accepts a complete completion report and summarises it for the parent", () => {
    const review = reviewSidecarReturn("completed", complete);
    expect(review.missing).toEqual([]);
    expect(review.lines).toContain("sidecar commits: abc1234");
    expect(review.lines).toContain("not verified: vitest (許可なし)");
  });

  it("lists missing return fields so the parent reviews the diff before adopting it", () => {
    const review = reviewSidecarReturn("completed", { summary: "done" });
    expect(review.missing).toEqual(["commits", "verification_done", "verification_skipped", "remaining", "consumption"]);
    expect(review.lines.at(-1)).toContain("sidecar return incomplete");
  });

  it("requires a failure reason only for failed reports", () => {
    expect(reviewSidecarReturn("completed", complete).missing).not.toContain("failure_reason");
    expect(reviewSidecarReturn("failed", complete).missing).toContain("failure_reason");
  });

  it("distinguishes a permission stop from a capability failure", () => {
    const review = reviewSidecarReturn("failed", { ...complete, failure_reason: "許可が確認できない", failure_kind: "permission" });
    expect(review.failureKind).toBe("permission");
    expect(review.lines.join("\n")).toContain("not a capability failure");
  });

  it("treats a missing payload as fully missing", () => {
    expect(reviewSidecarReturn("partial", undefined).missing).toHaveLength(6);
  });
});
