import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotionMapRepo } from "../db/notion-map-repo.js";
import { NotionMapRootsRepo } from "../db/notion-map-roots-repo.js";
import { applyMigrations } from "../db/schema.js";
import { buildKnowledgeRuntime } from "./knowledge-runtime.js";
import type { KnowledgeCollection } from "./knowledge-types.js";
import { createNotionMapCollector } from "./notion-map-crawl.js";
import { excludeWords } from "./notion-map-rules.js";
import { NOTION_MAP_DEFAULT_LIMITS, type NotionMapLimits } from "./notion-map-types.js";
import {
  NotionSourceUnavailable,
  type FetchedNotionPage,
  type NotionPageRef,
  type NotionPageSource,
} from "./notion-source-types.js";

// 実 Notion / 実 claude は呼ばない。 架空のページ (ID は連番の 32 桁) を返す偽の取得経路を使う。

const open: Database.Database[] = [];
afterEach(() => { for (const db of open.splice(0)) db.close(); });

const id = (n: number) => n.toString(16).padStart(32, "0");

interface FakePage {
  title: string;
  edited?: number | null;
  text: string;
  children?: Array<{ n: number; title?: string }>;
  links?: number[];
}

function fakeSource(pages: Record<number, FakePage>, opts: { unavailable?: boolean; missing?: Set<number>; failing?: Set<number>; unavailableAt?: Set<number> } = {}) {
  const calls: NotionPageRef[] = [];
  const source: NotionPageSource = {
    fetchPage: vi.fn(async (ref: NotionPageRef) => {
      calls.push(ref);
      if (opts.unavailable) throw new NotionSourceUnavailable("notion connector unavailable: not authenticated");
      const n = parseInt(ref.id, 16);
      if (opts.unavailableAt?.has(n)) throw new NotionSourceUnavailable("notion connector unavailable: tool not available");
      if (opts.failing?.has(n)) throw new Error("notion mcp returned an unexpected response (12 chars, no JSON object)");
      const p = pages[n];
      if (!p || opts.missing?.has(n)) return null;
      const page: FetchedNotionPage = {
        id: ref.id, title: p.title, url: `https://www.notion.so/example-${ref.id}`, lastEditedMs: p.edited === undefined ? 1000 : p.edited,
        text: p.text, children: (p.children ?? []).map((c) => ({ id: id(c.n), url: null, title: c.title ?? null })),
        links: (p.links ?? []).map(id), via: "mcp",
      };
      return page;
    }),
  };
  return { source, calls };
}

function harness(pages: Record<number, FakePage>, opts: {
  roots?: number[]; limits?: Partial<NotionMapLimits>; terms?: string[]; unavailable?: boolean; missing?: Set<number>; failing?: Set<number>; unavailableAt?: Set<number>;
} = {}) {
  const db = new Database(":memory:");
  open.push(db);
  applyMigrations(db);
  const repo = new NotionMapRepo(db);
  const rootStates = new NotionMapRootsRepo(db);
  const fake = fakeSource(pages, opts);
  const collector = createNotionMapCollector({
    source: fake.source, repo, rootStates, roots: () => (opts.roots ?? [1]).map((n) => ({ id: id(n), url: null })),
    excludes: () => excludeWords([]), limits: () => ({ ...NOTION_MAP_DEFAULT_LIMITS, ...opts.limits }),
    confidentialTerms: async () => opts.terms ?? [], nowMs: () => Date.parse("2026-10-18T00:00:00Z"),
  });
  const run = async (full = false) => await collector({ cursor: null, full }) as KnowledgeCollection;
  return { db, repo, rootStates, fake, collector, run };
}

/** 起点 1 → 第1回 (2) → 第2回 (3)、 起点 1 の子データベースの行 4 (Wiki の章)。 第1回 は 4 を参照、 第2回 は 第1回 を参照。 */
function lessonPages(): Record<number, FakePage> {
  return {
    1: { title: "例の授業資料", text: "起点の説明", children: [{ n: 2, title: "第1回" }, { n: 4, title: "Wiki 第1章" }] },
    2: { title: "第1回", text: "ゲームループの基本", children: [{ n: 3, title: "第2回" }], links: [4] },
    3: { title: "第2回", text: "当たり判定", links: [2] },
    4: { title: "Wiki 第1章", text: "ステートマシン" },
  };
}

describe("notion map crawl", () => {
  it("stops only Notion as not configured when the MCP connector is unavailable", async () => {
    const h = harness(lessonPages(), { unavailable: true });
    expect(await h.collector({ cursor: null, full: false })).toEqual({ notConfigured: "notion connector unavailable: not authenticated" });
    expect(h.rootStates.root(id(1))!.last_error).toMatch(/unavailable/);
  });

  it("walks child pages (including database rows) from the root, with paths and edges", async () => {
    const h = harness(lessonPages());
    const out = await h.run();
    expect(out.docs.map((d) => [d.docKey, d.path, d.scope])).toEqual([
      [`notion:${id(1)}`, "例の授業資料", "hq"],
      [`notion:${id(2)}`, "例の授業資料 > 第1回", "hq"],
      [`notion:${id(4)}`, "例の授業資料 > Wiki 第1章", "hq"],
      [`notion:${id(3)}`, "例の授業資料 > 第1回 > 第2回", "hq"],
    ]);
    expect(h.repo.edgesFrom(id(2))).toEqual([{ from: id(2), to: id(3), kind: "child" }, { from: id(2), to: id(4), kind: "link" }]);
    expect(h.repo.edgesFrom(id(3))).toEqual([{ from: id(3), to: id(2), kind: "link" }]);
    expect(out.retainDocKeys?.sort()).toEqual([1, 2, 3, 4].map((n) => `notion:${id(n)}`).sort());
    expect(h.rootStates.root(id(1))).toMatchObject({ title: "例の授業資料", pages: 4, excluded: 0, last_error: null });
  });

  it("skips excluded pages and everything under them without fetching them, storing only the count", async () => {
    const pages: Record<number, FakePage> = {
      1: { title: "例の学年", text: "学年の説明", children: [{ n: 2, title: "授業内容" }, { n: 5, title: "個人ページ一覧" }, { n: 7, title: "例のチーム" }, { n: 8 }] },
      2: { title: "授業内容", text: "第1回の内容" },
      5: { title: "個人ページ一覧", text: "一覧", children: [{ n: 6, title: "例の生徒" }] },
      6: { title: "例の生徒", text: "個人の記録" },
      7: { title: "例のチーム", text: "チームの記録" },
      // 親の一覧で題が分からないページは、 取ってから判定する
      8: { title: "タスクリスト", text: "やること" },
    };
    const h = harness(pages);
    const out = await h.run();
    expect(out.docs.map((d) => d.title)).toEqual(["例の学年", "授業内容"]);
    expect(h.repo.pages().map((p) => p.title)).toEqual(["例の学年", "授業内容"]);
    expect(h.rootStates.root(id(1))).toMatchObject({ pages: 2, excluded: 3 });
    expect(h.fake.calls.map((c) => c.id)).not.toContain(id(5));
    expect(h.fake.calls.map((c) => c.id)).not.toContain(id(6));
    expect(h.fake.calls.map((c) => c.id)).not.toContain(id(7));
    expect(JSON.stringify(h.repo.pages())).not.toMatch(/個人|チーム|タスク/);
  });

  it("drops pages that hit the confidential terms", async () => {
    const pages = lessonPages();
    pages[3]!.text = "ここに例の秘匿語がある";
    const h = harness(pages, { terms: ["例の秘匿語"] });
    const out = await h.run();
    expect(out.docs.map((d) => d.title)).not.toContain("第2回");
    expect(h.repo.page(id(3))).toBeNull();
  });

  it("respects the page and depth limits", async () => {
    expect((await harness(lessonPages(), { limits: { maxPages: 2 } }).run()).docs).toHaveLength(2);
    expect((await harness(lessonPages(), { limits: { maxDepth: 1 } }).run()).docs.map((d) => d.title)).not.toContain("第2回");
  });

  it("re-analyzes only pages whose last edit (or content when unknown) changed, keeping prior summaries", async () => {
    const pages = lessonPages();
    pages[4]!.edited = null;
    const h = harness(pages);
    await h.run();
    h.repo.setAnalysis(id(2), "第1回の要約", ["ループ"], 1);
    h.repo.setAnalysis(id(4), "章の要約", ["ステート"], 1);
    expect((await h.run()).docs).toEqual([]);
    expect(h.repo.page(id(2))).toMatchObject({ summary: "第1回の要約", analysis_pending: false });
    // 最終更新が変わったページ・最終更新の分からないページの本文が変わったときだけ解析し直す
    pages[2]!.edited = 5000;
    pages[4]!.text = "ステートマシン (改訂)";
    const third = await h.run();
    expect(third.docs.map((d) => d.title).sort()).toEqual(["Wiki 第1章", "第1回"].sort());
    expect(h.repo.page(id(2))).toMatchObject({ analysis_pending: true, summary: null });
    expect(h.repo.page(id(4))).toMatchObject({ analysis_pending: true, summary: null });
    // 手動の取り直し (full) は全ページを解析し直す
    expect((await h.run(true)).docs).toHaveLength(4);
  });

  it("keeps the previous map of a failed root and records the reason", async () => {
    const pages = { ...lessonPages(), 20: { title: "別の起点", text: "別の本文" } };
    const missing = new Set<number>();
    const h = harness(pages, { roots: [1, 20], missing });
    await h.run();
    expect(h.repo.pages(id(20))).toHaveLength(1);
    missing.add(20);
    const out = await h.run(true);
    expect(out.docs.map((d) => d.title)).not.toContain("別の起点");
    expect(h.repo.pages(id(20))).toHaveLength(1);
    expect(out.retainDocKeys).toContain(`notion:${id(20)}`);
    expect(h.rootStates.root(id(20))!.last_error).toMatch(/not reachable/);
    expect(h.rootStates.root(id(1))!.last_error).toBeNull();
    missing.add(1);
    await expect(h.run(true)).rejects.toThrow(/all notion map roots failed/);
  });

  it("skips only a sub-page that fails to load and keeps everything else read under the root", async () => {
    const h = harness(lessonPages(), { failing: new Set([2]) });
    const out = await h.run();
    // 第1回 (2) とその配下 (3) だけが欠け、 起点と Wiki の章は残る
    expect(out.docs.map((d) => d.title)).toEqual(["例の授業資料", "Wiki 第1章"]);
    expect(h.rootStates.root(id(1))).toMatchObject({ title: "例の授業資料", pages: 2, last_error: null });
    expect(h.collector.lastReport()?.[0]).toMatchObject({ status: "ok", pages: 2, failedPages: 1 });
  });

  it("fails only that root when a root page answers unavailable, and keeps crawling the other roots", async () => {
    const pages = { ...lessonPages(), 20: { title: "別の起点", text: "別の本文" } };
    const h = harness(pages, { roots: [20, 1], unavailableAt: new Set([20]) });
    const out = await h.run();
    expect(out.docs.map((d) => d.title)).toContain("例の授業資料");
    expect(h.rootStates.root(id(20))!.last_error).toMatch(/unavailable/);
    expect(h.rootStates.root(id(1))).toMatchObject({ title: "例の授業資料", pages: 4, last_error: null });
  });

  it("skips a sub-page that answers unavailable instead of stopping the whole Notion crawl", async () => {
    const h = harness(lessonPages(), { unavailableAt: new Set([2]) });
    const out = await h.run();
    expect(out.docs.map((d) => d.title)).toEqual(["例の授業資料", "Wiki 第1章"]);
    expect(h.collector.lastReport()?.[0]).toMatchObject({ status: "ok", pages: 2, failedPages: 1 });
  });

  it("still fails the root when the root page itself fails to load", async () => {
    const pages = { ...lessonPages(), 20: { title: "別の起点", text: "別の本文" } };
    const h = harness(pages, { roots: [1, 20], failing: new Set([1]) });
    await h.run();
    expect(h.rootStates.root(id(1))!.last_error).toMatch(/unexpected response/);
    expect(h.rootStates.root(id(20))).toMatchObject({ title: "別の起点", pages: 1 });
  });

  it("stops at another configured root under a root, and lets that root read its own pages", async () => {
    // 起点 1 の配下の 第1回 (2) も起点に設定されている
    const h = harness(lessonPages(), { roots: [1, 2] });
    await h.run();
    expect(h.repo.pages(id(1)).map((p) => p.title).sort()).toEqual(["Wiki 第1章", "例の授業資料"].sort());
    expect(h.repo.pages(id(2)).map((p) => p.title).sort()).toEqual(["第1回", "第2回"].sort());
    expect(h.rootStates.root(id(2))).toMatchObject({ title: "第1回", pages: 2, last_error: null });
  });
});

describe("notion map in the knowledge runtime", () => {
  it("stores pages as hq chunks and adds neighbor pages only on hq routes", async () => {
    const db = new Database(":memory:");
    open.push(db);
    applyMigrations(db);
    const fake = fakeSource(lessonPages());
    const runtime = buildKnowledgeRuntime({
      db, projects: () => [], publicProjects: () => [], confidentialTerms: async () => [],
      notionRoots: () => [`${id(1)} 例の授業資料`], notionSource: fake.source,
    });
    expect(await runtime.ingest.refresh(["notion"])).toMatchObject([{ kind: "notion", status: "refreshed" }]);
    expect(runtime.repo.list({ publicOnly: false }).every((c) => c.scope === "hq")).toBe(true);
    const hq = runtime.select({ texts: ["ゲームループの基本について"], allowHq: true });
    expect(hq[0]!.doc_key).toBe(`notion:${id(2)}`);
    // 第1回 の隣 (起点・第2回・Wiki 第1章) から補助的に足す (最大 2 件、 doc_key の順)
    expect(hq.slice(1).map((c) => c.doc_key)).toEqual([`notion:${id(1)}`, `notion:${id(3)}`]);
    expect(runtime.select({ texts: ["ゲームループの基本について"], allowHq: false })).toEqual([]);
    expect(runtime.notionRoots()).toMatchObject([{ root_id: id(1), title: "例の授業資料", pages: 4, excluded: 0 }]);
  });

  it("reports Notion as not configured when no MCP runner is wired and the page is not public", async () => {
    const db = new Database(":memory:");
    open.push(db);
    applyMigrations(db);
    const runtime = buildKnowledgeRuntime({
      db, projects: () => [], publicProjects: () => [], confidentialTerms: async () => [], notionRoots: () => [id(1)],
    });
    expect(await runtime.ingest.refresh(["notion"])).toMatchObject([{ kind: "notion", status: "not-configured" }]);
  });
});
