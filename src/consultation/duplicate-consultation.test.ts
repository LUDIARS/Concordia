import { describe, expect, it } from "vitest";
import {
  consultationSimilarity,
  duplicateShortcutBlock,
  findDuplicateCandidates,
  type PublishedConsultation,
} from "./duplicate-consultation.js";

const published = (title: string, summary: string, extra: Partial<PublishedConsultation> = {}): PublishedConsultation => ({
  title, summary, published_text: null, tabula_url: null, ...extra,
});

describe("consultationSimilarity", () => {
  it("同じ文は 1、 共通の 2 文字組が無ければ 0、 記号と空白は無視する", () => {
    expect(consultationSimilarity("Unity の当たり判定", "Unity の当たり判定")).toBe(1);
    expect(consultationSimilarity("あいう", "かきく")).toBe(0);
    expect(consultationSimilarity("当たり判定！", "当たり 判定")).toBe(1);
    expect(consultationSimilarity("", "当たり判定")).toBe(0);
  });
});

describe("findDuplicateCandidates", () => {
  const list = [
    published("Unity の当たり判定がすり抜ける", "高速で動く弾が壁をすり抜ける原因と対策"),
    published("DDD の集約の切り方", "集約の境界をどう決めるか"),
    published("当たり判定の負荷", "当たり判定が重いときの最適化"),
  ];

  it("似た公開相談を一致度の高い順に返し、 似ていないものは外す", () => {
    const result = findDuplicateCandidates("Unity で弾が壁をすり抜ける当たり判定の問題", list);
    expect(result[0]!.consultation.title).toBe("Unity の当たり判定がすり抜ける");
    expect(result.some((candidate) => candidate.consultation.title === "DDD の集約の切り方")).toBe(false);
  });

  it("空の問いや候補なしは空", () => {
    expect(findDuplicateCandidates("  ", list)).toEqual([]);
    expect(findDuplicateCandidates("当たり判定", [])).toEqual([]);
  });

  it("上限件数で切る", () => {
    const many = Array.from({ length: 5 }, (_, i) => published(`当たり判定 ${i}`, "当たり判定"));
    expect(findDuplicateCandidates("当たり判定", many, { max: 2 })).toHaveLength(2);
  });
});

describe("duplicateShortcutBlock", () => {
  it("候補が無ければ null", () => {
    expect(duplicateShortcutBlock([])).toBeNull();
  });

  it("記事のリンク・要約・公開済みの回答を載せ、 同じなら案内して差分だけ答えるよう伝える", () => {
    const block = duplicateShortcutBlock([{
      consultation: published("当たり判定", "すり抜けの対策", {
        tabula_url: "https://tabula.example/p/1", published_text: "連続衝突判定を使う。",
      }),
      score: 0.8,
    }])!;
    expect(block).toContain("過去の公開回答");
    expect(block).toContain("https://tabula.example/p/1");
    expect(block).toContain("すり抜けの対策");
    expect(block).toContain("連続衝突判定を使う。");
    expect(block).toContain("足りない点だけを追加で答えて");
  });

  it("長い公開回答は切り詰める", () => {
    const block = duplicateShortcutBlock([{
      consultation: published("t", "s", { published_text: "あ".repeat(3000) }), score: 1,
    }])!;
    expect(block.length).toBeLessThan(2000);
    expect(block.endsWith("…")).toBe(true);
  });
});
