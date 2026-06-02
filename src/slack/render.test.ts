import { describe, it, expect } from "vitest";
import {
  buildQuestionBlocks,
  extractRelayableFrame,
  parseAnswerActionId,
  truncateForSlack,
} from "./render.js";

describe("extractRelayableFrame", () => {
  it("kind=text & role=assistant は中継対象", () => {
    const r = extractRelayableFrame("text", { role: "assistant", text: "hello" });
    expect(r).toEqual({ role: "assistant", text: "hello" });
  });
  it("kind=text & role=user は中継しない", () => {
    expect(extractRelayableFrame("text", { role: "user", text: "hi" })).toBeNull();
  });
  it("kind=summary は中継対象（text/summary どちらのキーでも）", () => {
    expect(extractRelayableFrame("summary", { text: "S1" })).toEqual({ role: "summary", text: "S1" });
    expect(extractRelayableFrame("summary", { summary: "S2" })).toEqual({ role: "summary", text: "S2" });
  });
  it("tool-use / thinking / raw は中継しない", () => {
    expect(extractRelayableFrame("tool-use", { name: "Bash" })).toBeNull();
    expect(extractRelayableFrame("thinking", { preview: "..." })).toBeNull();
    expect(extractRelayableFrame("raw", { type: "x" })).toBeNull();
  });
  it("空 text は中継しない", () => {
    expect(extractRelayableFrame("text", { role: "assistant", text: "" })).toBeNull();
    expect(extractRelayableFrame("summary", {})).toBeNull();
  });
});

describe("buildQuestionBlocks", () => {
  it("各選択肢を action_id=cc_answer:<qid>:<index> のボタンにする", () => {
    const { text, blocks } = buildQuestionBlocks(42, "Which?", [
      { label: "A", description: "do a" },
      "B",
    ]);
    expect(text).toContain("Which?");
    const actions = (blocks as Array<{ type: string; elements?: Array<{ action_id: string; value: string }> }>).find(
      (b) => b.type === "actions",
    );
    expect(actions?.elements?.map((e) => e.action_id)).toEqual(["cc_answer:42:0", "cc_answer:42:1"]);
    expect(actions?.elements?.map((e) => e.value)).toEqual(["0", "1"]);
  });
});

describe("parseAnswerActionId", () => {
  it("正しい action_id を解析", () => {
    expect(parseAnswerActionId("cc_answer:42:1")).toEqual({ questionId: 42, answerIndex: 1 });
  });
  it("prefix 不一致 / 形式不正は null", () => {
    expect(parseAnswerActionId("other:1:2")).toBeNull();
    expect(parseAnswerActionId("cc_answer:42")).toBeNull();
    expect(parseAnswerActionId("cc_answer:x:1")).toBeNull();
    expect(parseAnswerActionId("cc_answer:42:-1")).toBeNull();
    expect(parseAnswerActionId("")).toBeNull();
  });
});

describe("truncateForSlack", () => {
  it("上限超過は末尾を … に置換", () => {
    expect(truncateForSlack("abcdef", 4)).toBe("abc…");
    expect(truncateForSlack("ab", 4)).toBe("ab");
  });
});
