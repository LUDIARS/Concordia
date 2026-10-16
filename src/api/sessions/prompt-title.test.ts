import { describe, expect, it } from "vitest";
import { decidePromptTitle, normalizeSummarizedTitle, PROMPT_TITLE_MAX } from "./prompt-title.js";

describe("decidePromptTitle (SPEC-SESSION-PROMPT-TITLE)", () => {
  it.each([
    "[Cc policy update]\nbranch: main\n必須設定は実行許可を追加しません。",
    "<pasted_content id=\"ced5\">\n[Cc policy update]\nrepo: E:/Document/Ars\n</pasted_content>",
    "<task-notification>\n<task-id>b1</task-id>",
    "<system-reminder>reminder</system-reminder>",
    "[自動確認] Cc の作業状態に応じた確認です。",
    "# Phase boundary handoff (taskflow:next-task)\n\n## Session contract",
    "⚠️ ブランチ切替を検知しました (main → fix/x)。",
    "次タスクを Actio から取得してください (actio:0690d8e1)",
    "   ",
    "「neco」さんからの指示: ",
    "「neco」さんからの指示: [Cc policy update]\nbranch: main",
  ])("treats a control inject as no title change: %s", (text) => {
    expect(decidePromptTitle(text)).toEqual({ kind: "control" });
  });

  it("strips the Discord requester prefix and keeps the first line of a human request", () => {
    const decision = decidePromptTitle("「neco」さんからの指示: Ccのタイトル変更が結構文章ではないのが多い\nHaikuは動いているか");
    expect(decision).toEqual({
      kind: "human",
      title: "Ccのタイトル変更が結構文章ではないのが多い",
      body: "Ccのタイトル変更が結構文章ではないのが多い\nHaikuは動いているか",
    });
  });

  it("uses a plain request as-is, collapsing whitespace and clipping long lines", () => {
    expect(decidePromptTitle("  MELPOT で   Pagus を動かす  ")).toMatchObject({ kind: "human", title: "MELPOT で Pagus を動かす" });
    const long = decidePromptTitle("あ".repeat(200));
    expect(long.kind).toBe("human");
    if (long.kind === "human") {
      expect(long.title).toHaveLength(PROMPT_TITLE_MAX);
      expect(long.title.endsWith("…")).toBe(true);
    }
  });
});

describe("normalizeSummarizedTitle", () => {
  it("accepts only a structured title with explicit context understanding", () => {
    expect(normalizeSummarizedTitle(JSON.stringify({ understood: true, title: "Cc セッションタイトルの要約修正" }))).toBe("Cc セッションタイトルの要約修正");
  });

  it.each([
    "", "[Cc policy update]", "依頼内容の要約から日本語タイトルを生成します。", "```json\n{}\n```",
    JSON.stringify({ understood: false, title: "文脈不明" }), JSON.stringify({ title: "題名" }),
    JSON.stringify({ understood: "true", title: "題名" }), JSON.stringify({ understood: true, title: "[Cc policy update]" }),
    JSON.stringify({ understood: true, title: "題\n名" }), JSON.stringify({ understood: true, title: "長".repeat(41) }),
  ])("rejects uncertain or malformed output: %s", raw => {
    expect(normalizeSummarizedTitle(raw)).toBeNull();
  });
});
