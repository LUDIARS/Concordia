import { describe, expect, it, vi } from "vitest";
import { parseLocalPrDetail } from "../pr/revisor-test-workflow-client.js";
import { buildTestForumCandidates } from "./test-forum-reconcile.js";
import { reviewDocuments, splitReviewText } from "./test-forum-report.js";
import { deliverReviewDocuments, reportMessages, type ReviewReportMessage } from "./test-forum-report-delivery.js";

function candidate(body = "Full PR description") {
  const detail = parseLocalPrDetail({ body, headRef: "feat/report", baseRef: "main", reviewReport: {
    version: 1, attemptId: "attempt-1", headSha: "a".repeat(40), entries: [
      { id: "start", kind: "review", label: "Review started", status: "running", at: "2026-09-12T09:00:00Z", content: "Started" },
      { id: "skip", kind: "check", label: "Runtime", status: "skipped", at: "2026-09-12T09:01:00Z", content: "Not required by plan" },
    ],
  } });
  if (!detail) throw new Error("Invalid fixture");
  return buildTestForumCandidates([{ id: "pr-1", repository: "LUDIARS/Example", number: 1,
    title: "Example", headRef: "feat/report", headSha: "a".repeat(40), reviewedHeadSha: null,
    repositoryRootPath: "E:/Example", checkStatus: "running", sessionId: null, detail }])[0];
}

describe("complete review documents", () => {
  it("retains the full PR body and skip reason, masking credentials", () => {
    const body = "本文\n".repeat(2000) + "Bearer secret-value";
    const docs = reviewDocuments(candidate(body));
    expect(docs[0].text).toContain("本文\n".repeat(2000));
    expect(docs[0].text).not.toContain("secret-value");
    expect(docs.some((doc) => doc.text.includes("Not required by plan"))).toBe(true);
    const messages = reportMessages(docs);
    expect(messages[0].attachment?.text).toBe(docs[0].text);
    expect(messages.every((message) => message.content.length <= 2000)).toBe(true);
  });
  it("keeps Unicode intact when splitting large attachments", () => {
    const text = "🧪".repeat(51);
    expect(splitReviewText(text, 11).join("")).toBe(text);
    expect(splitReviewText(text, 11).every((part) => !/[\ud800-\udbff]$/.test(part))).toBe(true);
  });
  it("recovers an accepted send with a lost response without duplicating it", async () => {
    const docs = reviewDocuments(candidate());
    const stored = new Set<string>();
    let loseResponse = true;
    const send = vi.fn(async (message: ReviewReportMessage) => {
      stored.add(message.key);
      if (loseResponse) { loseResponse = false; throw new Error("response lost"); }
    });
    const delivery = { readReceipts: async () => stored, send };
    await expect(deliverReviewDocuments(docs, delivery)).rejects.toThrow("response lost");
    await deliverReviewDocuments(docs, delivery);
    expect(send.mock.calls.map(([message]) => message.key).length).toBe(stored.size);
    await deliverReviewDocuments(docs, delivery);
    expect(send.mock.calls.length).toBe(stored.size);
  });
  it("does not resend when Discord history cannot be read", async () => {
    const send = vi.fn();
    await expect(deliverReviewDocuments(reviewDocuments(candidate()), {
      readReceipts: async () => { throw new Error("history denied"); }, send,
    })).rejects.toThrow("history denied");
    expect(send).not.toHaveBeenCalled();
  });
});
