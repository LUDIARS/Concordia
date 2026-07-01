import { describe, it, expect } from "vitest";
import { wrapTablesInCode, splitPreservingBlocks, formatForChunkedPost } from "./message-blocks.js";

const FENCE = "```";

describe("wrapTablesInCode", () => {
  it("テーブルを ``` で囲む (前後テキスト保持)", () => {
    const text = "前文\n| A | B |\n|---|---|\n| 1 | 2 |\n後文";
    const out = wrapTablesInCode(text);
    expect(out).toBe(`前文\n${FENCE}\n| A | B |\n|---|---|\n| 1 | 2 |\n${FENCE}\n後文`);
  });
  it("テーブルが無ければそのまま", () => {
    expect(wrapTablesInCode("ただのテキスト\n2 行目")).toBe("ただのテキスト\n2 行目");
  });
  it("既に ``` 内のテーブルは二重に囲まない", () => {
    const text = `${FENCE}\n| A | B |\n|---|---|\n| 1 | 2 |\n${FENCE}`;
    expect(wrapTablesInCode(text)).toBe(text);
  });
  it("連続データ行をすべて含める", () => {
    const out = wrapTablesInCode("| H |\n|---|\n| a |\n| b |\n| c |");
    expect(out).toBe(`${FENCE}\n| H |\n|---|\n| a |\n| b |\n| c |\n${FENCE}`);
  });
});

describe("splitPreservingBlocks", () => {
  it("上限内なら 1 メッセージ", () => {
    expect(splitPreservingBlocks("短い", 100)).toEqual(["短い"]);
  });
  it("コードブロックをまたいで割らない (入らなければ次メッセージへ丸ごと)", () => {
    const block = `${FENCE}\n|A|\n${FENCE}`; // 11 chars
    const text = `あいうえお\n${block}`; // prose 5 + block 11、合計は maxLen 超
    // maxLen=12: prose(5) は単独で入り、block(11) は prose と同居できず丸ごと次へ
    const out = splitPreservingBlocks(text, 12);
    expect(out).toEqual(["あいうえお", block]);
  });
  it("単体で上限超のブロックは行単位で割り各チャンクを再フェンス", () => {
    const block = `${FENCE}\nrow-aaaa\nrow-bbbb\nrow-cccc\nrow-dddd\n${FENCE}`;
    const out = splitPreservingBlocks(block, 25);
    expect(out.length).toBeGreaterThan(1);
    // 各チャンクが ``` で開閉している
    for (const m of out) {
      expect(m.startsWith(FENCE)).toBe(true);
      expect(m.trimEnd().endsWith(FENCE)).toBe(true);
    }
  });
  it("地のテキストは行/上限で分割しブロックを壊さない", () => {
    const out = splitPreservingBlocks(" a\nb\nc\nd", 3);
    expect(out.every((m) => m.length <= 3)).toBe(true);
    expect(out.join("")).toContain("a");
  });
});

describe("formatForChunkedPost", () => {
  it("テーブルを囲んで 1 メッセージに収まれば 1 要素", () => {
    const out = formatForChunkedPost("x\n| A |\n|---|\n| 1 |", 100);
    expect(out.length).toBe(1);
    expect(out[0]).toContain(FENCE);
  });
  it("上限超はブロック安全分割", () => {
    const long = "あ".repeat(50) + "\n| A |\n|---|\n| 1 |";
    const out = formatForChunkedPost(long, 30);
    expect(out.length).toBeGreaterThan(1);
    // テーブルのフェンスが割れていない (どこかのメッセージに丸ごと入る)
    expect(out.some((m) => m.includes("| A |") && m.includes(FENCE))).toBe(true);
  });
});
