import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { parseLocalPrDetail } from "../pr/revisor-test-workflow-client.js";
import { buildTestForumCandidates } from "./test-forum-reconcile.js";
import { UNREADABLE_CONTENT_NOTICE } from "./test-forum-report-content.js";
import { reviewDocuments, splitReviewText } from "./test-forum-report.js";
import { deliverReviewDocuments, reportMessages, type ReviewReportMessage } from "./test-forum-report-delivery.js";

const HEAD = "a".repeat(40);
const ATTEMPT = "attempt-1";

type Entry = { id: string; kind: string; label: string; status: string; at: string; content: string };

const START: Entry = {
  id: "review-start", kind: "review", label: "Review started", status: "running",
  at: "2026-09-12T09:00:00Z", content: "Review worker started.",
};
const SKIPPED_TESTS: Entry = {
  id: "stage:tests", kind: "check", label: "tests check", status: "skipped",
  at: "2026-09-12T09:01:00Z", content: "Reused from an equivalent completed review stage.",
};
const FINAL: Entry = {
  id: "final", kind: "outcome", label: "Review completed", status: "passed", at: "2026-09-12T09:05:00Z",
  content: JSON.stringify({
    conclusion: "success",
    reasons: [],
    advisories: ["呼び出しグラフの複雑度は据え置き"],
    reviewer: "codex-sol",
    reviewerOutput: "変更は仕様どおりです。\n境界の扱いも妥当です。",
    reusedStages: ["tests"],
    security: { status: "passed", totalFindings: 0, failOnSeverity: "high", findings: [] },
    ci: [{ name: "unit", status: "passed", exitCode: 0, durationMs: 12_000 }],
    anatomiaGate: null,
  }),
};

function candidate(options: { body?: string; entries?: Entry[]; pr?: Record<string, unknown> } = {}) {
  const detail = parseLocalPrDetail({
    body: options.body ?? "Full PR description",
    headRef: "feat/report",
    baseRef: "main",
    reviewReport: { version: 1, attemptId: ATTEMPT, headSha: HEAD, entries: options.entries ?? [START, SKIPPED_TESTS, FINAL] },
    decision: { label: "自動マージ可", mergeable: true, riskScore: 26, riskThreshold: 30, riskBandLabel: "中", blockers: [] },
    mergeRisk: {
      factors: [
        { code: "diff_size", points: 6, detail: "4 ファイル / 320 行の変更" },
        { code: "runtime_verification", points: 20, detail: "人間による動作確認が必要な変更です" },
      ],
    },
    ci: [
      { name: "unit", status: "passed", exitCode: 0, durationMs: 12_000 },
      { name: "e2e", status: "skipped", reason: "plan excluded runtime" },
    ],
    ...options.pr,
  });
  if (!detail) throw new Error("Invalid fixture");
  return buildTestForumCandidates([{ id: "pr-1", repository: "LUDIARS/Example", number: 1,
    title: "Example", headRef: "feat/report", headSha: HEAD, reviewedHeadSha: null,
    repositoryRootPath: "E:/Example", checkStatus: "test_ok", sessionId: null, detail }])[0];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("complete review documents", () => {
  it("retains the full PR body, masking credentials", () => {
    const body = "本文\n".repeat(2000) + "Bearer secret-value";
    const docs = reviewDocuments(candidate({ body }));
    expect(docs[0].text).toContain("本文\n".repeat(2000));
    expect(docs[0].text).not.toContain("secret-value");
    const messages = reportMessages(docs);
    expect(messages[0].attachment?.text).toBe(docs[0].text);
    expect(messages[0].attachment?.name).toBe("pr-body.txt");
    expect(messages.every((message) => message.content.length <= 2000)).toBe(true);
  });

  it("describes start, skip and the passed review in Japanese without JSON, hashes or receipts", () => {
    const docs = reviewDocuments(candidate());
    const byTitle = new Map(docs.map((doc) => [doc.title, doc.text]));
    expect(byTitle.get("レビュー開始")).toContain("審査を開始しました。");
    expect(byTitle.get("登録テスト — スキップ")).toContain("スキップ理由: 同じ内容で完了済みの審査段階の結果を引き継いだ");
    const final = byTitle.get("レビュー完了 — 通過") ?? "";
    expect(final).toContain("結論: 審査を通過しました。");
    expect(final).toContain("変更は仕様どおりです。\n境界の扱いも妥当です。");
    expect(final).toContain("- unit — 通過 · exit code 0 · 所要 12 秒");
    expect(final).toContain("引き継いだ審査段階: 登録テスト");
    for (const doc of docs) {
      expect(doc.text).not.toMatch(/[{[]\s*"/);
      expect(doc.text).not.toContain(HEAD);
      expect(doc.text).not.toContain(ATTEMPT);
    }
    for (const message of reportMessages(docs)) {
      expect(message.content).not.toContain(message.key);
      expect(message.content).not.toContain("Revisor report");
    }
  });

  it("lists the merge-risk breakdown and every registered check in the decision", () => {
    const decision = reviewDocuments(candidate()).find((doc) => doc.title === "審査結果・判断事項")?.text ?? "";
    expect(decision).toContain("26 / 100 (中) · 閾値 30");
    expect(decision).toContain("- +6 4 ファイル / 320 行の変更");
    expect(decision).toContain("- +20 人間による動作確認が必要な変更です");
    expect(decision).toContain("■ 登録チェック: 1 件通過 / 実行 1 件（スキップ 1 件は含めない）");
    expect(decision).toContain("通過したチェック:\n- unit — 通過 · exit code 0 · 所要 12 秒");
    expect(decision).toContain("スキップ理由: plan excluded runtime");
  });

  it("says what is missing instead of fabricating a breakdown or review text", () => {
    const oldFinal: Entry = { ...FINAL, content: JSON.stringify({ conclusion: "success", reasons: [], advisories: [], reviewer: "codex-sol", ci: [] }) };
    const docs = reviewDocuments(candidate({ entries: [oldFinal], pr: { mergeRisk: undefined } }));
    const decision = docs.find((doc) => doc.title === "審査結果・判断事項")?.text ?? "";
    expect(decision).toContain("内訳は Revisor から取得できませんでした。");
    expect(decision).not.toContain("加点要因はありません。");
    const final = docs.find((doc) => doc.title === "レビュー完了 — 通過")?.text ?? "";
    expect(final).toContain("この記録は Revisor がレビュー本文を保存する前の形式のため、本文は未取得です。");
    expect(final).not.toContain("変更は仕様どおりです");
  });

  it("never posts fragments of broken or masked structured records", () => {
    const broken: Entry = { ...FINAL, content: "{\"conclusion\":\"success\",\"reasons\":[" };
    const masked: Entry = { ...SKIPPED_TESTS, id: "stage:security", status: "passed", content: "[redacted: generic-secret]" };
    const docs = reviewDocuments(candidate({ entries: [masked, broken] }));
    const texts = docs.map((doc) => doc.text).join("\n");
    expect(texts).toContain(UNREADABLE_CONTENT_NOTICE);
    expect(texts).toContain("Revisor がこの記録の内容をマスクしました");
    expect(texts).not.toContain("\"conclusion\"");
  });

  it("does not re-key the decision when only the report history advances", () => {
    const key = (entries: Entry[]) => reviewDocuments(candidate({ entries })).find((doc) => doc.title === "審査結果・判断事項")?.key;
    expect(key([START])).toBe(key([START, SKIPPED_TESTS]));
  });

  it("recognizes documents delivered under the former footer receipts", () => {
    const built = candidate();
    const oldText = [`日時: ${START.at}`, `審査: ${ATTEMPT} / コミット: ${HEAD}`, START.content].join("\n\n");
    const oldDocumentKey = sha256(JSON.stringify(["LUDIARS/Example#1", `${ATTEMPT}:${START.id}`, `${START.label} — ${START.status}`, oldText]));
    const start = reportMessages(reviewDocuments(built)).find((message) => message.content.startsWith("**レビュー開始**"));
    expect(start?.legacyKeys).toEqual([sha256(`${oldDocumentKey}:0`)]);
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

  it("does not resend when receipts cannot be read", async () => {
    const send = vi.fn();
    await expect(deliverReviewDocuments(reviewDocuments(candidate()), {
      readReceipts: async () => { throw new Error("history denied"); }, send,
    })).rejects.toThrow("history denied");
    expect(send).not.toHaveBeenCalled();
  });
});
