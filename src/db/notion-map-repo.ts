/**
 * Notion 記事マップのページと辺の永続 (spec/feature/patrol-chat.md「知識」の「Notion 記事マップ」、 migration 143)。
 * - ページ: 起点・題・パス・深さ・更新時刻・要約・キーワード・解析待ち。 除外したページは置かない
 * - 辺: ページ間の参照 (child / link)。 隣のページの補助取得に使う
 * 起点ごとの状態・まとめと全体の概観は notion-map-roots-repo.ts。
 */

import type Database from "better-sqlite3";
import type { NotionEdge, NotionMapPage } from "../rules/notion-map-types.js";

interface PageRow {
  page_id: string;
  root_id: string;
  title: string;
  url: string | null;
  path: string;
  depth: number;
  last_edited_ms: number | null;
  content_hash: string | null;
  summary: string | null;
  keywords: string;
  analysis_pending: number;
  analysis_attempted_at: number | null;
  fetched_at: number;
}

/** 前回のクロールで分かっているページ (差分取得で本文を読まないときに使う)。 */
export interface StoredMapPage extends NotionMapPage {
  /** 本文の指紋 (最終更新が分からない経路の差分に使う)。 */
  content_hash: string | null;
  analysis_attempted_at: number | null;
}

/** クロールの結果 1 ページ分。 */
export interface CrawledMapPage extends NotionMapPage {
  /** 本文の指紋 (最終更新が分からない経路の差分に使う)。 */
  content_hash: string | null;
}

const parseList = (raw: string): string[] => {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

function toPage(row: PageRow): StoredMapPage {
  return {
    page_id: row.page_id,
    root_id: row.root_id,
    title: row.title,
    url: row.url,
    path: row.path,
    depth: row.depth,
    last_edited_ms: row.last_edited_ms,
    summary: row.summary,
    keywords: parseList(row.keywords),
    analysis_pending: row.analysis_pending === 1,
    content_hash: row.content_hash,
    analysis_attempted_at: row.analysis_attempted_at,
  };
}

export class NotionMapRepo {
  constructor(private readonly db: Database.Database) {}

  page(pageId: string): StoredMapPage | null {
    const row = this.db.prepare(`SELECT * FROM notion_map_pages WHERE page_id = ?`).get(pageId) as PageRow | undefined;
    return row ? toPage(row) : null;
  }

  pages(rootId?: string): StoredMapPage[] {
    const rows = rootId
      ? this.db.prepare(`SELECT * FROM notion_map_pages WHERE root_id = ? ORDER BY path, page_id`).all(rootId)
      : this.db.prepare(`SELECT * FROM notion_map_pages ORDER BY root_id, path, page_id`).all();
    return (rows as PageRow[]).map(toPage);
  }

  /** ページから出る辺 (前回のクロールのもの)。 */
  edgesFrom(pageId: string): NotionEdge[] {
    return (this.db.prepare(`SELECT from_page, to_page, kind FROM notion_map_edges WHERE from_page = ? ORDER BY kind, to_page`)
      .all(pageId) as Array<{ from_page: string; to_page: string; kind: NotionEdge["kind"] }>)
      .map((r) => ({ from: r.from_page, to: r.to_page, kind: r.kind }));
  }

  /** 隣のページ (どちら向きの辺でも)。 マップに無いページ (除外したページ等) は返さない。 決定的な順。 */
  neighbors(pageIds: readonly string[]): string[] {
    if (pageIds.length === 0) return [];
    const marks = pageIds.map(() => "?").join(", ");
    const rows = this.db.prepare(`
      SELECT DISTINCT n.page_id AS page_id FROM (
        SELECT to_page AS page_id FROM notion_map_edges WHERE from_page IN (${marks})
        UNION SELECT from_page AS page_id FROM notion_map_edges WHERE to_page IN (${marks})
      ) n JOIN notion_map_pages p ON p.page_id = n.page_id
      ORDER BY n.page_id
    `).all(...pageIds, ...pageIds) as Array<{ page_id: string }>;
    const own = new Set(pageIds);
    return rows.map((r) => r.page_id).filter((id) => !own.has(id));
  }

  /**
   * 起点 1 つ分のクロール結果で置き換える。 起点の配下に無くなったページ (除外になったもの・消えたもの) と、
   * それらから出る辺を消す。 要約・解析待ちはクロール結果の値をそのまま書く (変わらないページは前回の値を渡す)。
   */
  replaceRoot(rootId: string, pages: CrawledMapPage[], edges: NotionEdge[], fetchedAt: number): void {
    this.db.transaction(() => {
      const keep = new Set(pages.map((p) => p.page_id));
      const old = this.db.prepare(`SELECT page_id FROM notion_map_pages WHERE root_id = ?`).all(rootId) as Array<{ page_id: string }>;
      const delPage = this.db.prepare(`DELETE FROM notion_map_pages WHERE page_id = ?`);
      const delEdges = this.db.prepare(`DELETE FROM notion_map_edges WHERE from_page = ?`);
      for (const { page_id } of old) {
        delEdges.run(page_id);
        if (!keep.has(page_id)) delPage.run(page_id);
      }
      const upsert = this.db.prepare(`
        INSERT INTO notion_map_pages
          (page_id, root_id, title, url, path, depth, last_edited_ms, content_hash, summary, keywords, analysis_pending, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(page_id) DO UPDATE SET
          root_id = excluded.root_id, title = excluded.title, url = excluded.url, path = excluded.path, depth = excluded.depth,
          last_edited_ms = excluded.last_edited_ms, content_hash = excluded.content_hash, summary = excluded.summary,
          keywords = excluded.keywords, analysis_pending = excluded.analysis_pending, fetched_at = excluded.fetched_at,
          analysis_attempted_at = CASE WHEN excluded.analysis_pending = 1 AND notion_map_pages.analysis_pending = 0
            THEN NULL ELSE notion_map_pages.analysis_attempted_at END
      `);
      for (const p of pages) {
        delEdges.run(p.page_id);
        upsert.run(p.page_id, rootId, p.title, p.url, p.path, p.depth, p.last_edited_ms, p.content_hash,
          p.summary, JSON.stringify(p.keywords), p.analysis_pending ? 1 : 0, fetchedAt);
      }
      const insEdge = this.db.prepare(`INSERT OR IGNORE INTO notion_map_edges (from_page, to_page, kind) VALUES (?, ?, ?)`);
      for (const e of edges) if (keep.has(e.from) && e.from !== e.to) insEdge.run(e.from, e.to, e.kind);
    })();
  }

  /** 設定から外れた起点のページと、 それらから出る辺を消す。 消したページの id を返す。 */
  dropRootsExcept(rootIds: readonly string[]): string[] {
    const keep = new Set(rootIds);
    const dropped = this.pages().filter((p) => !keep.has(p.root_id)).map((p) => p.page_id);
    const delEdges = this.db.prepare(`DELETE FROM notion_map_edges WHERE from_page = ?`);
    const delPage = this.db.prepare(`DELETE FROM notion_map_pages WHERE page_id = ?`);
    this.db.transaction(() => {
      for (const id of dropped) {
        delEdges.run(id);
        delPage.run(id);
      }
    })();
    return dropped;
  }

  /** 解析待ちのページ。 前回の試みから retryAfterSec 経っていないものは後回し。 */
  pendingAnalyses(nowSec: number, retryAfterSec: number, limit: number): StoredMapPage[] {
    const rows = this.db.prepare(`
      SELECT * FROM notion_map_pages
      WHERE analysis_pending = 1 AND (analysis_attempted_at IS NULL OR analysis_attempted_at <= ?)
      ORDER BY analysis_attempted_at IS NOT NULL, analysis_attempted_at, page_id LIMIT ?
    `).all(nowSec - retryAfterSec, limit) as PageRow[];
    return rows.map(toPage);
  }

  setAnalysis(pageId: string, summary: string, keywords: string[], at: number): void {
    this.db.prepare(`
      UPDATE notion_map_pages SET summary = ?, keywords = ?, analysis_pending = 0, analysis_attempted_at = ? WHERE page_id = ?
    `).run(summary, JSON.stringify(keywords), at, pageId);
  }

  /** 解析の失敗。 要約なしのまま解析待ちに残し、 次の機会にやり直す。 */
  markAnalysisFailed(pageId: string, at: number): void {
    this.db.prepare(`UPDATE notion_map_pages SET analysis_attempted_at = ? WHERE page_id = ?`).run(at, pageId);
  }
}
