import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatKnowledgeRepo } from "../db/chat-knowledge-repo.js";
import { NotionMapRepo, type CrawledMapPage } from "../db/notion-map-repo.js";
import { NotionMapRootsRepo } from "../db/notion-map-roots-repo.js";
import { applyMigrations } from "../db/schema.js";
import { NOTION_SUMMARY_SEQ } from "./knowledge-types.js";
import {
  NOTION_ANALYSIS_LIMITS,
  buildOverview,
  createNotionMapAnalyzer,
  parsePageAnalysis,
  parseRootSummary,
  rootSummaryBasis,
} from "./notion-map-analyze.js";

// 実 LLM は呼ばない。 one-shot runner を差し替える。

const open: Database.Database[] = [];
afterEach(() => { for (const db of open.splice(0)) db.close(); });

function page(pageId: string, title: string, extra: Partial<CrawledMapPage> = {}): CrawledMapPage {
  return {
    page_id: pageId, root_id: "root1", title, url: `https://example.test/${pageId}`, path: `例の起点 > ${title}`, depth: 1,
    last_edited_ms: 1000, summary: null, keywords: [], analysis_pending: true, content_hash: null, ...extra,
  };
}

function harness(runner: (prompt: string) => { ok: boolean; stdout: string }) {
  const db = new Database(":memory:");
  open.push(db);
  applyMigrations(db);
  const map = new NotionMapRepo(db);
  const roots = new NotionMapRootsRepo(db);
  const knowledge = new ChatKnowledgeRepo(db);
  const clock = { ms: Date.parse("2026-10-18T00:00:00Z") };
  map.replaceRoot("root1", [page("p1", "第1回"), page("p2", "第2回")], [], 1);
  roots.markRootSuccess("root1", { title: "例の起点", pages: 2, excluded: 1 }, 1);
  for (const key of ["p1", "p2"]) {
    knowledge.replaceDocs("notion", [`notion:${key}`], [{
      doc_type: "notion-page", doc_key: `notion:${key}`, seq: 0, title: key, url: null, repo: null, path: null, scope: "hq",
      body: `${key} の本文`, source_updated_at: 1,
    }], 1);
  }
  const run = vi.fn(async (prompt: string, _opts: { model: string; timeoutMs: number; conversationOnly: true }) => ({ ...runner(prompt), stderr: "" }));
  const analyzer = createNotionMapAnalyzer({ repo: map, roots, knowledge, runner: run, nowMs: () => clock.ms });
  return { map, roots, knowledge, analyzer, run, clock };
}

const pageJson = JSON.stringify({ summary: "ゲームループの要約", keywords: ["ゲームループ", "フレーム"] });
const rootJson = JSON.stringify({ overview: "ゲーム制作の基礎を扱う", chapters: ["第1回", "第2回"], keywords: ["ゲームループ"] });

describe("notion map analysis", () => {
  it("summarizes pending pages with haiku in conversation-only mode and stores a summary chunk", async () => {
    const h = harness((prompt) => ({ ok: true, stdout: prompt.includes("起点:") ? rootJson : pageJson }));
    const r = await h.analyzer.tick();
    expect(r.analyzed).toBe(2);
    expect(h.run.mock.calls[0]![1]).toMatchObject({ model: "haiku", conversationOnly: true });
    expect(h.run.mock.calls[0]![0]).toContain("<data>");
    expect(h.map.page("p1")).toMatchObject({ summary: "ゲームループの要約", keywords: ["ゲームループ", "フレーム"], analysis_pending: false });
    const chunks = h.knowledge.docChunks("notion:p1");
    expect(chunks.map((c) => c.seq)).toEqual([0, NOTION_SUMMARY_SEQ]);
    expect(chunks[1]!.body).toContain("要約: ゲームループの要約");
    expect(chunks[1]!.scope).toBe("hq");
    // まとめ (起点 1 回) と概観
    expect(r.rootSummaries).toBe(1);
    expect(h.roots.root("root1")!.summary).toContain("概要: ゲーム制作の基礎を扱う");
    expect(h.roots.overview()).toMatchObject({ total_pages: 2, roots: [{ root_id: "root1", title: "例の起点", pages: 2 }] });
  });

  it("leaves a page without a summary when analysis fails, and retries after an hour", async () => {
    const h = harness(() => ({ ok: false, stdout: "" }));
    await h.analyzer.tick();
    expect(h.map.page("p1")).toMatchObject({ summary: null, analysis_pending: true });
    expect(h.knowledge.docChunks("notion:p1").map((c) => c.seq)).toEqual([0]);
    h.run.mockClear();
    await h.analyzer.tick();
    expect(h.run).not.toHaveBeenCalled();
    h.clock.ms += (NOTION_ANALYSIS_LIMITS.retryAfterSec + 1) * 1000;
    await h.analyzer.tick();
    expect(h.run).toHaveBeenCalled();
  });

  it("rebuilds the root summary only when the pages under it change", async () => {
    const h = harness((prompt) => ({ ok: true, stdout: prompt.includes("起点:") ? rootJson : pageJson }));
    await h.analyzer.tick();
    h.run.mockClear();
    h.clock.ms += 2 * NOTION_ANALYSIS_LIMITS.retryAfterSec * 1000;
    expect((await h.analyzer.tick()).rootSummaries).toBe(0);
    expect(h.run).not.toHaveBeenCalled();
    // ページが変わったら (解析し直してから) まとめも作り直す
    h.map.replaceRoot("root1", [page("p1", "第1回", { last_edited_ms: 2000 }), page("p2", "第2回", { summary: "s", keywords: ["k"], analysis_pending: false })], [], 2);
    const r = await h.analyzer.tick();
    expect(r.analyzed).toBe(1);
    expect(r.rootSummaries).toBe(1);
  });
});

describe("notion map analysis helpers", () => {
  it("parses only well-formed analysis output", () => {
    expect(parsePageAnalysis("noise {\"summary\": \" 要約 \", \"keywords\": [\"a\", \"a\", 1, \"b\"]} tail")).toEqual({ summary: "要約", keywords: ["a", "b"] });
    expect(parsePageAnalysis("not json")).toBeNull();
    expect(parsePageAnalysis(JSON.stringify({ keywords: [] }))).toBeNull();
    expect(parseRootSummary(rootJson)).toBe("概要: ゲーム制作の基礎を扱う\n主な章・回: 第1回、第2回\n主要キーワード: ゲームループ");
    expect(parseRootSummary("{}")).toBeNull();
  });

  it("computes a deterministic basis and overview", () => {
    const a = [page("p1", "第1回", { keywords: ["x", "y"] }), page("p2", "第2回", { keywords: ["y"] })];
    expect(rootSummaryBasis(a)).toBe(rootSummaryBasis([...a].reverse()));
    expect(rootSummaryBasis(a)).not.toBe(rootSummaryBasis([a[0]!, { ...a[1]!, last_edited_ms: 9 }]));
    expect(buildOverview([{ root_id: "root1", title: "例の起点" }], a, 5)).toEqual({
      generated_at: 5, total_pages: 2, roots: [{ root_id: "root1", title: "例の起点", pages: 2, topics: ["y", "x"] }], topics: ["y", "x"],
    });
  });
});
