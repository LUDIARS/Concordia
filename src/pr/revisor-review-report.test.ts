import { describe, expect, it } from "vitest";
import { parseReviewReport } from "./revisor-review-report.js";

describe("Revisor report boundary", () => {
  it("distinguishes an old producer from malformed evidence", () => {
    expect(parseReviewReport(undefined)).toBeNull();
    expect(() => parseReviewReport({ version: 1 })).toThrow();
  });
  it("preserves skipped evidence, complete content and attempt identity", () => {
    const raw = { version: 1, attemptId: "retry-2", headSha: "a".repeat(40), entries: [{
      id: "security:result", kind: "check", label: "Security", status: "skipped",
      at: "2026-09-12T09:00:00.000Z", content: "Not required by the review plan.\n" + "詳細".repeat(5000),
    }] };
    expect(parseReviewReport(raw)).toEqual(raw);
    expect(() => parseReviewReport({ ...raw, entries: [{ ...raw.entries[0], at: "invalid" }] })).toThrow();
  });
});
