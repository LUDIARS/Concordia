import { describe, expect, it } from "vitest";
import { isNoGoalPost } from "./no-goal-policy.js";

describe("isNoGoalPost (目標なしの宣言)", () => {
  it("accepts 目標なし with surrounding spaces, punctuation and polite endings", () => {
    for (const text of ["目標なし", " 目標なし。", "目標なしです", "目標無しです！", "「目標なし」", "目標なしで。"]) {
      expect(isNoGoalPost(text)).toBe(true);
    }
  });

  it("rejects posts that only contain the phrase", () => {
    for (const text of ["目標なしで Cc の調査をする", "今日は目標なしかも", "目標", ""]) expect(isNoGoalPost(text)).toBe(false);
  });
});
