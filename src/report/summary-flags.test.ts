import { describe, it, expect } from "vitest";
import {
  parseSummaryFlags,
  mergeFlags,
  hasFlags,
  renderSummaryFlagsMarkdown,
  EMPTY_FLAGS,
} from "./summary-flags.js";

describe("parseSummaryFlags", () => {
  it("素の JSON を解釈", () => {
    expect(parseSummaryFlags('{"blocked":["X を権限拒否"],"needsHuman":["方針確認"]}')).toEqual({
      blocked: ["X を権限拒否"],
      needsHuman: ["方針確認"],
    });
  });
  it("code fence 付き / 前後テキスト混じりも拾う", () => {
    const t = "結果です:\n```json\n{\"blocked\":[],\"needsHuman\":[\"破壊的操作の確認\"]}\n```";
    expect(parseSummaryFlags(t)).toEqual({ blocked: [], needsHuman: ["破壊的操作の確認"] });
  });
  it("非文字列/空要素は落とす", () => {
    expect(parseSummaryFlags('{"blocked":["a", "", 3, "  "],"needsHuman":[]}')).toEqual({
      blocked: ["a"],
      needsHuman: [],
    });
  });
  it("解釈不能は null", () => {
    expect(parseSummaryFlags("これはJSONではない")).toBeNull();
  });
});

describe("mergeFlags / hasFlags", () => {
  it("結合し重複排除", () => {
    expect(mergeFlags({ blocked: ["a", "b"], needsHuman: ["x"] }, { blocked: ["b"], needsHuman: ["x", "y"] })).toEqual({
      blocked: ["a", "b"],
      needsHuman: ["x", "y"],
    });
  });
  it("hasFlags は空で false", () => {
    expect(hasFlags(EMPTY_FLAGS)).toBe(false);
    expect(hasFlags({ blocked: [], needsHuman: ["x"] })).toBe(true);
  });
});

describe("renderSummaryFlagsMarkdown", () => {
  it("両方あれば 2 セクション", () => {
    const lines = renderSummaryFlagsMarkdown({ blocked: ["B1"], needsHuman: ["H1", "H2"] });
    expect(lines).toContain("## 🚧 ハーネスによるブロック");
    expect(lines).toContain("- B1");
    expect(lines).toContain("## 🙋 人間に確認してほしいこと");
    expect(lines).toContain("- H1");
    expect(lines).toContain("- H2");
  });
  it("片方だけならそのセクションのみ", () => {
    expect(renderSummaryFlagsMarkdown({ blocked: [], needsHuman: ["H"] })).toEqual([
      "## 🙋 人間に確認してほしいこと",
      "- H",
    ]);
  });
  it("両方空なら空配列", () => {
    expect(renderSummaryFlagsMarkdown(EMPTY_FLAGS)).toEqual([]);
  });
});
