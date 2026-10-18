import { describe, expect, it } from "vitest";
import type { KnowledgeChunk } from "./knowledge-types.js";
import { knowledgeTextsFor, notionPageIdOf, withNeighborPages } from "./knowledge-usage.js";

function chunk(key: string, scope: "hq" | "public", body = "本文"): KnowledgeChunk {
  return {
    id: 1, source_kind: "notion", doc_type: "notion-page", doc_key: key, seq: 0, title: `題 ${key}`, url: null, repo: null, path: null,
    scope, body, source_updated_at: null, fetched_at: 1,
  };
}

describe("knowledgeTextsFor (where knowledge is used)", () => {
  it("uses knowledge only for replies, queried by the reply and the previous bot text", () => {
    const input = { replies: ["返信の本文"], previousBotText: "直前の投稿" };
    expect(knowledgeTextsFor("pick", input)).toBeNull();
    expect(knowledgeTextsFor("event", input)).toBeNull();
    expect(knowledgeTextsFor("followup", input)).toBeNull();
    expect(knowledgeTextsFor("reply", input)).toEqual(["返信の本文", "直前の投稿"]);
    expect(knowledgeTextsFor("reply", { replies: [" "], previousBotText: null })).toEqual([]);
  });
});

describe("withNeighborPages", () => {
  it("adds up to two neighbors in doc_key order, skipping picked docs", () => {
    const picked = [chunk("notion:b", "hq")];
    const out = withNeighborPages(picked, [chunk("notion:d", "hq"), chunk("notion:b", "hq"), chunk("notion:a", "hq"), chunk("notion:c", "hq")], { allowHq: true });
    expect(out.map((c) => c.doc_key)).toEqual(["notion:b", "notion:a", "notion:c"]);
  });

  it("keeps the count and byte limits, and never adds hq on a public route", () => {
    const picked = [chunk("p1", "public")];
    expect(withNeighborPages(picked, [chunk("notion:a", "hq"), chunk("x", "public")], { allowHq: false }).map((c) => c.doc_key)).toEqual(["p1", "x"]);
    expect(withNeighborPages(picked, [chunk("notion:a", "public")], { allowHq: true, limit: 1 })).toHaveLength(1);
    const big = chunk("notion:z", "hq", "あ".repeat(1000));
    expect(withNeighborPages(picked, [big], { allowHq: true, maxBytes: 100 }).map((c) => c.doc_key)).toEqual(["p1"]);
    expect(withNeighborPages([chunk("notion:h", "hq")], [], { allowHq: false })).toEqual([]);
  });

  it("reads the page id from a Notion doc key", () => {
    expect(notionPageIdOf("notion:abc")).toBe("abc");
    expect(notionPageIdOf("repo:Ex:README.md")).toBeNull();
  });
});
