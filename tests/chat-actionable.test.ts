import { describe, it, expect } from "vitest";
import { isActionableSuggestion } from "../src/chat-actionable.js";

describe("isActionableSuggestion", () => {
  it("flags Japanese suggestion verbs", () => {
    expect(isActionableSuggestion("もう少し async にした方がいい")).toBe(true);
    expect(isActionableSuggestion("ここで test 追加した方が安全")).toBe(true);
    expect(isActionableSuggestion("削除しても良さそう")).toBe(true);
  });

  it("flags TODO/FIXME mentions", () => {
    expect(isActionableSuggestion("TODO: edge case を見直す")).toBe(true);
    expect(isActionableSuggestion("// FIXME async race")).toBe(true);
  });

  it("ignores plain chitchat", () => {
    expect(isActionableSuggestion("今日の進捗、 ふつう")).toBe(false);
    expect(isActionableSuggestion("テストうるさい")).toBe(false);
  });
});
