import { describe, expect, it } from "vitest";
import { answeredByDisplayName, discordAnsweredFieldName, slackAnsweredLabel } from "./question-answered-display.js";

describe("question answered display (SPEC-GOAL-STOP-Q-06)", () => {
  it("names Genius as the answerer and keeps the human heading unchanged", () => {
    expect(answeredByDisplayName("genius")).toContain("Genius");
    expect(answeredByDisplayName(undefined)).toBeNull();
    expect(discordAnsweredFieldName("genius")).toBe("✅ 回答 — Genius 判断 (Cc の自動回答)");
    expect(discordAnsweredFieldName(undefined)).toBe("✅ 回答");
  });
  it("shows the option for an index answer and the text for a free-text answer", () => {
    expect(slackAnsweredLabel({ answer_index: 1, answer_text: "案B" })).toBe("✅ *回答済み*\n選択肢 2: 案B");
    const genius = slackAnsweredLabel({ answer_index: -1, answer_text: "[Genius 判断] 進める", answered_by: "genius" });
    expect(genius).toBe("✅ *回答済み* — Genius 判断 (Cc の自動回答)\n[Genius 判断] 進める");
    expect(genius).not.toContain("選択肢 0");
  });
});
