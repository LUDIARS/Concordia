import { describe, expect, it } from "vitest";
import { recencyPenalty, relevanceScore, topicSimilarity } from "./patrol-topics.js";

// GLab は TGS にマルチパーティゲーム・リズムゲーム・ローグライトのカード/アクションを出展 (neco 2026-10-15 の例)。
const GLAB = ["TGS", "パーティゲーム", "リズムゲーム", "ローグライト", "カードゲーム", "アクションゲーム"];

describe("relevance to the server's interests", () => {
  it("scores titles that contain the server's keywords, capped at 3", () => {
    expect(relevanceScore("新作ローグライトのカードゲームがSteamで話題", GLAB)).toBe(2);
    expect(relevanceScore("ＴＧＳ２０２６ リズムゲーム ローグライト カードゲーム 特集", GLAB)).toBe(3);
    expect(relevanceScore("大臣が交代", GLAB)).toBe(0);
    expect(relevanceScore("anything", [])).toBe(0);
  });
});

describe("recent topics penalty (relaxed day by day)", () => {
  const title = "淀川花火大会 2026 の開催が決定";
  it("penalises 3 / 2 / 1 for today / yesterday / two days ago, and nothing after", () => {
    expect(recencyPenalty(title, [{ text: "淀川花火大会 2026", ageDays: 0 }])).toBe(3);
    expect(recencyPenalty(title, [{ text: "淀川花火大会 2026", ageDays: 1 }])).toBe(2);
    expect(recencyPenalty(title, [{ text: "淀川花火大会 2026", ageDays: 2 }])).toBe(1);
    expect(recencyPenalty(title, [{ text: "淀川花火大会 2026", ageDays: 3 }])).toBe(0);
  });

  it("uses the most recent similar topic and matches keywords from conversations", () => {
    expect(recencyPenalty(title, [{ text: "花火大会", ageDays: 2 }, { text: "淀川花火大会2026", ageDays: 0 }])).toBe(3);
    expect(recencyPenalty("新しいリズムゲームが発表", [{ text: "リズムゲーム", ageDays: 1 }])).toBe(2);
    expect(recencyPenalty("農林水産大臣", [{ text: "淀川花火大会 2026", ageDays: 0 }])).toBe(0);
  });

  it("measures similarity with character bigrams", () => {
    expect(topicSimilarity("淀川花火大会 2026", "淀川花火大会2026")).toBe(1);
    expect(topicSimilarity("abc", "xyz")).toBe(0);
  });
});
