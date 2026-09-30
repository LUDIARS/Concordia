import { describe, expect, it } from "vitest";
import { classifyConversationInput, directLines } from "./input-intent.js";

describe("classifyConversationInput", () => {
  it.each([
    ["次の作業", ""],
    ["次の作業: 設定画面の文言を直す", "設定画面の文言を直す"],
    ["次のタスクへ進んでください\nログ画面の修正", "ログ画面の修正"],
    ["/next-work API のテスト追加", "API のテスト追加"],
    ["次の作業へ移って", ""],
  ])("starts a handoff only on an explicit direct instruction: %s", (text, instruction) => {
    expect(classifyConversationInput(text)).toEqual({ kind: "next_work", instruction });
  });

  it.each([
    "> 次の作業\nこれは引用です",
    "```\n次の作業\n```",
    "さっき「次の作業」と言ったけど",
    "次の作業はまだしないで",
    "次の作業まだ待って",
    "次の作業者に共有",
  ])("does not start a handoff from quotes, code, mentions or negations: %s", (text) => {
    expect(classifyConversationInput(text).kind).toBe("work");
  });

  it("recognises short stop and cancel instructions", () => {
    expect(classifyConversationInput("停止して")).toEqual({ kind: "stop" });
    expect(classifyConversationInput("/stop")).toEqual({ kind: "stop" });
    expect(classifyConversationInput("キャンセル")).toEqual({ kind: "cancel" });
    expect(classifyConversationInput("中止してください。")).toEqual({ kind: "cancel" });
    expect(classifyConversationInput("停止ボタンの色を変えて").kind).toBe("work");
  });

  it("drops quoted and fenced lines", () => {
    expect(directLines("> quoted\nkept\n```\nhidden\n```\n  also kept  ")).toEqual(["kept", "also kept"]);
  });
});
