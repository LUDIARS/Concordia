import { describe, expect, it, vi } from "vitest";
import type { ReviewReportMessage } from "./test-forum-report-delivery.js";
import {
  RECEIPT_CLOCK_SKEW_MS,
  receiptHistoryWindow,
  settleReceipts,
  type ReportReceipt,
  type ThreadReceiptLedger,
  type ThreadReportPost,
} from "./test-forum-report-receipts.js";

function message(key: string, content: string, attachment?: string, legacyKeys: string[] = []): ReviewReportMessage {
  return {
    key,
    legacyKeys,
    content,
    ...(attachment === undefined ? {} : { attachment: { name: `${key}.txt`, text: attachment } }),
  };
}

function post(overrides: Partial<ThreadReportPost> = {}): ThreadReportPost {
  return { id: "post-1", createdAtMs: 10_000, content: "", attachments: [], legacyReceiptKey: null, ...overrides };
}

function attachmentOf(name: string, text: string, readText = vi.fn(async () => text)) {
  return { name, size: new TextEncoder().encode(text).length, readText };
}

function ledger() {
  return {
    list: vi.fn((): ReportReceipt[] => []),
    legacyImported: vi.fn(() => true),
    importLegacy: vi.fn((_keys: readonly string[]) => undefined),
    markPending: vi.fn((_key: string, _attemptedAtMs: number) => undefined),
    markDelivered: vi.fn((_key: string, _messageId: string | null) => undefined),
    forget: vi.fn((_key: string) => undefined),
  } satisfies ThreadReceiptLedger;
}

function pending(key: string, attemptedAtMs = 10_000): ReportReceipt {
  return { key, state: "pending", messageId: null, attemptedAtMs };
}

describe("receiptHistoryWindow", () => {
  it("reads the whole thread once to import former footer receipts, then only around pending sends", () => {
    expect(receiptHistoryWindow([], false)).toEqual({ notBeforeMs: 0 });
    expect(receiptHistoryWindow([{ key: "a", state: "delivered", messageId: "m", attemptedAtMs: 1 }], true)).toBeNull();
    expect(receiptHistoryWindow([pending("a", 500_000), pending("b", 400_000)], true))
      .toEqual({ notBeforeMs: 400_000 - RECEIPT_CLOCK_SKEW_MS });
  });
});

describe("settleReceipts", () => {
  it("imports only fully receipted former documents, in one ledger write", async () => {
    const recorded = ledger();
    const history = [post({ legacyReceiptKey: "old-a1" }), post({ id: "post-2", legacyReceiptKey: "old-a2" }), post({ id: "post-3", legacyReceiptKey: "old-b1" })];
    const delivered = await settleReceipts({
      messages: [message("a", "A", undefined, ["old-a1", "old-a2"]), message("b", "B", undefined, ["old-b1", "old-b2"])],
      receipts: [],
      legacyImported: false,
      history,
      ledger: recorded,
    });
    expect(recorded.importLegacy).toHaveBeenCalledTimes(1);
    expect(recorded.importLegacy).toHaveBeenCalledWith(["a"]);
    expect([...delivered]).toEqual(["a"]);
  });

  it("confirms a lost send only when the preview and the whole attachment match", async () => {
    const recorded = ledger();
    const preview = "**レビュー完了 — 通過**\n同じプレビュー";
    const history = [
      post({ id: "different-tail", content: preview, attachments: [attachmentOf("k1.txt", "前半 後半X")] }),
      post({ id: "same", content: preview, attachments: [attachmentOf("k1.txt", "前半 後半Y")] }),
    ];
    const delivered = await settleReceipts({
      messages: [message("k1", preview, "前半 後半Y")],
      receipts: [pending("k1")],
      legacyImported: true,
      history,
      ledger: recorded,
    });
    expect(recorded.markDelivered).toHaveBeenCalledWith("k1", "same");
    expect(recorded.forget).not.toHaveBeenCalled();
    expect(delivered.has("k1")).toBe(true);
  });

  it("forgets a pending send that never reached the thread so it can be resent", async () => {
    const recorded = ledger();
    const delivered = await settleReceipts({
      messages: [message("k1", "本文")],
      receipts: [pending("k1", 500_000)],
      legacyImported: true,
      history: [post({ content: "本文", createdAtMs: 500_000 - RECEIPT_CLOCK_SKEW_MS - 1 })],
      ledger: recorded,
    });
    expect(recorded.forget).toHaveBeenCalledWith("k1");
    expect(delivered.has("k1")).toBe(false);
  });

  it("does not reuse a post already bound to another receipt", async () => {
    const recorded = ledger();
    await settleReceipts({
      messages: [message("k1", "同じ本文"), message("k2", "同じ本文")],
      receipts: [{ key: "k1", state: "delivered", messageId: "post-1", attemptedAtMs: 10_000 }, pending("k2")],
      legacyImported: true,
      history: [post({ content: "同じ本文" })],
      ledger: recorded,
    });
    expect(recorded.markDelivered).not.toHaveBeenCalled();
    expect(recorded.forget).toHaveBeenCalledWith("k2");
  });

  it("stops without settling when an attachment cannot be read", async () => {
    const recorded = ledger();
    const unreadable = attachmentOf("k1.txt", "全文", vi.fn(async () => { throw new Error("CDN unavailable"); }));
    await expect(settleReceipts({
      messages: [message("k1", "プレビュー", "全文")],
      receipts: [pending("k1")],
      legacyImported: true,
      history: [post({ content: "プレビュー", attachments: [unreadable] })],
      ledger: recorded,
    })).rejects.toThrow("CDN unavailable");
    expect(recorded.forget).not.toHaveBeenCalled();
    expect(recorded.markDelivered).not.toHaveBeenCalled();
  });
});
