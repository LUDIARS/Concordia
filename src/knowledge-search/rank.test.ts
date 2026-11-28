import { describe, expect, it } from "vitest";
import { makeOkfTags } from "./okf.js";
import { queryTagCandidates, rankDocuments, type SearchDoc } from "./rank.js";

const doc = (docKey: string, title: string, body: string, tags: string[] = []): SearchDoc => ({
  docKey, source: "ludiars", title, url: null, body, okf: tags.length ? makeOkfTags({ type: "feature", title, tags }) : null,
});

describe("rankDocuments", () => {
  it("OKF タグの一致を本文の一致より上に置く", () => {
    const docs = [
      doc("a", "描画の話", "shader を少し使う vulkan の説明"),
      doc("b", "パイプライン", "描画パイプラインの設計", ["shader", "vulkan"]),
    ];
    const ranked = rankDocuments("shader", docs);
    expect(ranked.map((r) => r.doc.docKey)).toEqual(["b", "a"]);
    expect(ranked[0].matchedTags).toEqual(["shader"]);
  });
  it("弱い一致 (日本語 2 文字の組 1 つだけ) は採らない", () => {
    expect(rankDocuments("設計", [doc("a", "題", "設計")])).toEqual([]);
  });
  it("空の検索語・空の文書は空", () => {
    expect(rankDocuments(" ", [doc("a", "x", "y")])).toEqual([]);
    expect(rankDocuments("x", [])).toEqual([]);
  });
  it("件数と合計バイトの上限を守る (先頭 1 件は必ず入れる)", () => {
    const docs = Array.from({ length: 5 }, (_, i) => doc(`d${i}`, `unity ${i}`, "unity " + "x".repeat(100)));
    expect(rankDocuments("unity", docs, { limit: 3, maxBytes: 10_000 })).toHaveLength(3);
    expect(rankDocuments("unity", docs, { limit: 5, maxBytes: 150 })).toHaveLength(1);
  });
  it("同点は docKey の順", () => {
    const ranked = rankDocuments("react", [doc("z", "react", "react"), doc("m", "react", "react")]);
    expect(ranked.map((r) => r.doc.docKey)).toEqual(["m", "z"]);
  });
});

describe("queryTagCandidates", () => {
  it("全体と区切った語をタグ候補にする", () => {
    expect([...queryTagCandidates("Unity, ECS")]).toEqual(["unity,-ecs", "unity", "ecs"]);
  });
});
