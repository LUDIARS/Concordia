import { describe, expect, it } from "vitest";
import { knowledgeBytes, knowledgeTerms, selectKnowledge } from "./knowledge-select.js";
import type { KnowledgeChunk } from "./knowledge-types.js";

let nextId = 1;
function chunk(over: Partial<KnowledgeChunk>): KnowledgeChunk {
  return {
    id: nextId++, source_kind: "ludiars", doc_type: "readme", doc_key: `doc:${nextId}`, seq: 0, title: "t", url: null,
    repo: null, path: null, scope: "public", body: "", source_updated_at: null, fetched_at: 1, ...over,
  };
}

const corpus = [
  chunk({ doc_key: "repo:Ex:README.md", title: "Examplia README", body: "Examplia は巡回チャットの素材を集めるサービス。" }),
  chunk({ doc_key: "repo:Ex:spec/a.md", title: "Examplia 素材元", body: "素材元の一覧と取得の契約。" }),
  chunk({ doc_key: "notion:p1", source_kind: "notion", doc_type: "notion-page", scope: "hq", title: "Examplia の運用メモ", body: "本社だけの運用の話。" }),
  chunk({ doc_key: "repo:Other:README.md", title: "Otherium README", body: "まったく別のゲーム。" }),
];

describe("selectKnowledge (chat-knowledge-C-4)", () => {
  it("is deterministic and ranks the related chunks", () => {
    const query = { texts: ["Examplia の素材が増えた"], allowHq: true };
    const a = selectKnowledge(corpus, query).map((s) => s.chunk.doc_key);
    const b = selectKnowledge([...corpus].reverse(), query).map((s) => s.chunk.doc_key);
    expect(a).toEqual(b);
    expect(a).toContain("repo:Ex:README.md");
    expect(a).not.toContain("repo:Other:README.md");
  });

  it("never returns hq chunks on a public route", () => {
    const picked = selectKnowledge(corpus, { texts: ["Examplia の運用"], allowHq: false });
    expect(picked.length).toBeGreaterThan(0);
    expect(picked.every((s) => s.chunk.scope === "public")).toBe(true);
    const withHq = selectKnowledge(corpus, { texts: ["Examplia の運用"], allowHq: true });
    expect(withHq.some((s) => s.chunk.scope === "hq")).toBe(true);
  });

  it("keeps to the count and byte limits", () => {
    const many = Array.from({ length: 20 }, (_, i) => chunk({ doc_key: `doc:${i}`, title: `Examplia ${i}`, body: "Examplia ".repeat(30) }));
    const picked = selectKnowledge(many, { texts: ["Examplia"], allowHq: true, limit: 3, maxBytes: 700 });
    expect(picked.length).toBeLessThanOrEqual(3);
    expect(picked.reduce((n, s) => n + knowledgeBytes(s.chunk), 0)).toBeLessThanOrEqual(700);
    expect(selectKnowledge(many, { texts: ["Examplia"], allowHq: true }).length).toBeLessThanOrEqual(5);
  });

  it("takes at most two chunks from one document", () => {
    const same = Array.from({ length: 4 }, (_, seq) => chunk({ doc_key: "repo:Ex:README.md", seq, title: "Examplia", body: `Examplia ${seq}` }));
    expect(selectKnowledge(same, { texts: ["Examplia"], allowHq: true })).toHaveLength(2);
  });

  it("returns nothing for an unrelated or empty query", () => {
    expect(selectKnowledge(corpus, { texts: ["zzz"], allowHq: true })).toEqual([]);
    expect(selectKnowledge(corpus, { texts: [], allowHq: true })).toEqual([]);
  });
});

describe("knowledgeTerms", () => {
  it("uses ascii words and two-character pairs", () => {
    const terms = knowledgeTerms("Examplia 素材元");
    expect(terms.has("w:examplia")).toBe(true);
    expect(terms.has("b:素材")).toBe(true);
    expect(terms.has("b:材元")).toBe(true);
  });
});
