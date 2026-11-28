/**
 * 検索対象のローカル文書の読み出し (spec/feature/slack-knowledge-search.md KS-4)。
 *
 * - ナレッジフローの採用文書 (knowledge_flow_documents)。 タグは分析結果の category・tags
 * - Notion 記事マップのページ (notion_map_pages)。 タグは解析済みの keywords
 * - 巡回チャットの知識の断片 (chat_knowledge_chunks、 notion 以外)。 文書の鍵ごとに断片をつなぐ
 *
 * 表がまだ無い (機能が未初期化) ときはその出典を空として扱う。 他ドメインの表は読むだけで書かない。
 * SRP: 読み出しと SearchDoc への変換だけ。 タグの付与は tagger.ts。
 */

import { createHash } from "node:crypto";
import type { Database } from "better-sqlite3";
import { makeOkfTags, type OkfTags } from "./okf.js";
import type { SearchDoc } from "./rank.js";

/** 断片をつなぐときの文書あたりの上限 (検索と生成に使う分だけ)。 */
const DOC_BODY_MAX = 12_000;

export interface CorpusDoc extends SearchDoc {
  bodyHash: string;
  /** 出典側で決まっているタグ (LLM で付けない)。 null なら tagger の対象。 */
  intrinsicOkf: OkfTags | null;
}

export function bodyHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

function hasTable(db: Database, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function parseList(json: string | null): string[] {
  if (!json) return [];
  try {
    const value = JSON.parse(json) as unknown;
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch { return []; }
}

function flowDocs(db: Database): CorpusDoc[] {
  if (!hasTable(db, "knowledge_flow_documents") || !hasTable(db, "knowledge_flow_articles")) return [];
  const hasJobs = hasTable(db, "knowledge_flow_jobs");
  const rows = db.prepare(`SELECT d.article_id, d.kind, d.markdown, a.url${hasJobs ? ", j.report" : ", NULL AS report"}
    FROM knowledge_flow_documents d JOIN knowledge_flow_articles a ON a.id = d.article_id
    ${hasJobs ? "LEFT JOIN knowledge_flow_jobs j ON j.article_id = d.article_id" : ""}
    ORDER BY d.article_id, d.kind`).all() as Array<{ article_id: number; kind: string; markdown: string; url: string; report: string | null }>;
  return rows.map((row) => {
    let category: string | null = null;
    let tags: string[] = [];
    try {
      const e = (JSON.parse(row.report ?? "null") as { evaluation?: { category?: string; tags?: string[] } } | null)?.evaluation;
      category = e?.category ?? null;
      tags = Array.isArray(e?.tags) ? e!.tags! : [];
    } catch { /* 分析結果が読めなければタグなし */ }
    const heading = /^#\s+(.+)$/m.exec(row.markdown)?.[1]?.trim();
    const title = heading || `記事 #${row.article_id}`;
    const body = row.markdown.slice(0, DOC_BODY_MAX);
    return {
      docKey: `knowledge-flow:${row.article_id}:${row.kind}`,
      source: "knowledge-flow" as const,
      title,
      url: row.url,
      body,
      bodyHash: bodyHash(body),
      okf: null,
      intrinsicOkf: makeOkfTags({ type: row.kind === "skill" ? "setup" : "article", title, domain: category, tags: category ? [...tags, category] : tags }),
    };
  });
}

function notionDocs(db: Database): CorpusDoc[] {
  if (!hasTable(db, "notion_map_pages")) return [];
  const rows = db.prepare("SELECT page_id, title, url, path, summary, keywords FROM notion_map_pages ORDER BY page_id")
    .all() as Array<{ page_id: string; title: string; url: string | null; path: string | null; summary: string | null; keywords: string | null }>;
  return rows.map((row) => {
    const keywords = parseList(row.keywords);
    const body = [row.path ?? "", row.summary ?? "", keywords.join(" ")].filter(Boolean).join("\n").slice(0, DOC_BODY_MAX);
    return {
      docKey: `notion:${row.page_id}`,
      source: "notion" as const,
      title: row.title,
      url: row.url,
      body,
      bodyHash: bodyHash(body),
      okf: null,
      intrinsicOkf: keywords.length ? makeOkfTags({ type: "note", title: row.title, tags: keywords }) : null,
    };
  });
}

function chunkDocs(db: Database): CorpusDoc[] {
  if (!hasTable(db, "chat_knowledge_chunks")) return [];
  const rows = db.prepare(`SELECT doc_key, seq, title, url, body FROM chat_knowledge_chunks
    WHERE source_kind <> 'notion' ORDER BY doc_key, seq`).all() as Array<{ doc_key: string; seq: number; title: string; url: string | null; body: string }>;
  const docs = new Map<string, { title: string; url: string | null; parts: string[]; size: number }>();
  for (const row of rows) {
    const doc = docs.get(row.doc_key) ?? { title: row.title, url: row.url, parts: [], size: 0 };
    if (doc.size < DOC_BODY_MAX) { doc.parts.push(row.body); doc.size += row.body.length; }
    docs.set(row.doc_key, doc);
  }
  return [...docs].map(([key, doc]) => {
    const body = doc.parts.join("\n").slice(0, DOC_BODY_MAX);
    return { docKey: `ludiars:${key}`, source: "ludiars" as const, title: doc.title, url: doc.url, body, bodyHash: bodyHash(body), okf: null, intrinsicOkf: null };
  });
}

/** 検索対象の全文書 (タグは未結合。 tagger / use case が tag-store と結ぶ)。 */
export function loadCorpus(db: Database): CorpusDoc[] {
  return [...flowDocs(db), ...notionDocs(db), ...chunkDocs(db)];
}
