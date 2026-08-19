import { describe, expect, it } from "vitest";
import {
  countReplacementChars,
  describeMojibakeRejection,
  hasReplacementChars,
  REPLACEMENT_CHAR,
} from "./text-integrity.js";

const CORRUPTED_NOTE = `test ${REPLACEMENT_CHAR}${REPLACEMENT_CHAR} note`;

describe("countReplacementChars", () => {
  it("counts every replacement character", () => {
    expect(countReplacementChars(CORRUPTED_NOTE)).toBe(2);
  });

  it("returns zero for text that survived the transport intact", () => {
    expect(countReplacementChars("日本語を含むテスト用のメモ")).toBe(0);
    expect(countReplacementChars("")).toBe(0);
  });

  it("does not miss replacement characters that follow an astral-plane character", () => {
    // for...of で数えるのはサロゲートペアを 1 文字として跨ぐため。
    expect(countReplacementChars(`🍣${REPLACEMENT_CHAR}`)).toBe(1);
  });
});

describe("hasReplacementChars", () => {
  it("flags text broken by the transport", () => {
    expect(hasReplacementChars(CORRUPTED_NOTE)).toBe(true);
  });

  it("accepts intact Japanese text", () => {
    expect(hasReplacementChars("文字化けしていない日本語")).toBe(false);
  });
});

describe("describeMojibakeRejection", () => {
  it("names the field, the damage, and the way to resend", () => {
    const message = describeMojibakeRejection("note", CORRUPTED_NOTE);
    expect(message).toContain("note");
    expect(message).toContain("2 文字");
    expect(message).toContain("--data-binary");
  });
});
