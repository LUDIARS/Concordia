import { describe, expect, it } from "vitest";
import { buildAnswerText, isAnswerAction, reservedAnswerAction } from "./reaction-workflow-answer.js";
import { classifyReactionWorkflow, isReservedNonActionEmoji, planWorkflow } from "./reaction-workflow.js";

describe("OK / NG の予約語", () => {
  it.each([
    ["👍", "ok"], ["👍🏽", "ok"], ["🆗", "ok"],
    ["👎", "ng"], ["👎🏻", "ng"], ["🆖", "ng"],
  ] as const)("%s は %s", (emoji, action) => {
    expect(reservedAnswerAction(` ${emoji} `)).toBe(action);
    expect(isAnswerAction(action)).toBe(true);
  });

  it("設定の上書きでも付け替えられない", () => {
    expect(classifyReactionWorkflow("👍", { "👍": "memoria-note" })).toBe("ok");
    expect(classifyReactionWorkflow("👎", { "👎": "handoff-document" })).toBe("ng");
  });

  it("👌 の無視予約とは別物で、ほかの絵文字は予約語ではない", () => {
    expect(reservedAnswerAction("👌")).toBeNull();
    expect(isReservedNonActionEmoji("👍")).toBe(false);
    expect(reservedAnswerAction("🙏")).toBeNull();
    expect(isAnswerAction("start-impl")).toBe(false);
  });

  it("返答の語を先頭に置き、どの発言への返答かを添える", () => {
    expect(buildAnswerText("ok", { messageText: "進めてよいですか？", authorLabel: "Claude" }))
      .toBe("良い\n(👍 Claude の発言「進めてよいですか？」への返答)");
    expect(buildAnswerText("ng", { messageText: "", authorLabel: "Claude" })).toBe("NG");
    expect(buildAnswerText("ok", { messageText: "x".repeat(250), authorLabel: "a" })).toContain("…」");
  });

  it("組み込みの inject 計画になる (スキルを経由しない)", () => {
    const ctx = { messageText: "承認して", authorLabel: "Claude", repoPath: null, sessionActive: true, memoriaPath: "", reactorId: "u1" };
    expect(planWorkflow("ok", ctx)).toMatchObject({ action: "ok", mode: "inject", prompt: expect.stringMatching(/^良い/) });
    expect(planWorkflow("ng", ctx)).toMatchObject({ action: "ng", mode: "inject", prompt: expect.stringMatching(/^NG/) });
  });
});
