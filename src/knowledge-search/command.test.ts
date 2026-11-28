import { describe, expect, it } from "vitest";
import { normalizeQuery, parseMentionCommand, parseWorkflowQuery } from "./command.js";

describe("parseMentionCommand", () => {
  it("Bot 宛てのナレッジ検索から検索語を取り出す", () => {
    expect(parseMentionCommand("<@UBOT> ナレッジ検索  Unity   シェーダー ", "UBOT")).toEqual({ kind: "search", query: "Unity シェーダー" });
  });
  it("検索語が空なら使い方", () => {
    expect(parseMentionCommand("<@UBOT> ナレッジ検索", "UBOT")).toEqual({ kind: "usage" });
  });
  it("Bot 宛てでない・コマンドでない・Bot 不明は対象外", () => {
    expect(parseMentionCommand("<@UOTHER> ナレッジ検索 Unity", "UBOT")).toEqual({ kind: "none" });
    expect(parseMentionCommand("<@UBOT> こんにちは", "UBOT")).toEqual({ kind: "none" });
    expect(parseMentionCommand("<@UBOT> ナレッジ検索 Unity", null)).toEqual({ kind: "none" });
  });
  it("他の人へのメンションは検索語に含めない", () => {
    expect(parseMentionCommand("<@UBOT> <@U12345678> ナレッジ検索 ECS", "UBOT")).toEqual({ kind: "search", query: "ECS" });
  });
});

describe("parseWorkflowQuery / normalizeQuery", () => {
  it("ワークフローの入力を検索語にする", () => {
    expect(parseWorkflowQuery(" ＵＩ設計 ")).toEqual({ kind: "search", query: "UI設計" });
    expect(parseWorkflowQuery(undefined)).toEqual({ kind: "usage" });
  });
  it("200 文字で切る", () => {
    expect(Array.from(normalizeQuery("あ".repeat(300)))).toHaveLength(200);
  });
});
