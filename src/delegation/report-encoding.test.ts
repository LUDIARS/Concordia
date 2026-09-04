import { describe, expect, it } from "vitest";

import { findGarbledReportFields, GARBLED_REPORT_HINT } from "./report-encoding.js";

// CP932 のバイト列を UTF-8 として読むと、U+FFFD と偶然妥当な文字が混在し得る。
const GARBLED = "synthetic report �Ғ�،��";

describe("findGarbledReportFields", () => {
  it("accepts a clean Japanese report", () => {
    expect(findGarbledReportFields({
      result: "Tier 1 ingest を完走しました (110 文書)",
      remaining: [{ title: "夜間 run の再開", note: "サービス停止中" }],
    })).toEqual([]);
  });

  it("names every garbled field with its index", () => {
    expect(findGarbledReportFields({
      detail: GARBLED,
      result: "正常な本文",
      remaining: [
        { title: "正常な残作業" },
        { title: GARBLED, note: GARBLED, scope_dirs: ["src", GARBLED] },
      ],
      acceptance_report: [
        { criterion: "正常な条件" },
        { criterion: GARBLED, note: GARBLED },
      ],
    })).toEqual([
      "detail",
      "remaining[1].title",
      "remaining[1].note",
      "remaining[1].scope_dirs[1]",
      "acceptance_report[1].criterion",
      "acceptance_report[1].note",
    ]);
  });

  it("ignores absent fields", () => {
    expect(findGarbledReportFields({})).toEqual([]);
    expect(findGarbledReportFields({ remaining: [{ title: "残り" }] })).toEqual([]);
  });

  it("tells the sender how to resend", () => {
    expect(GARBLED_REPORT_HINT).toContain("--data-binary");
  });
});
