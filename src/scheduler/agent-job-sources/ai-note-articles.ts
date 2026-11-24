/**
 * AIノートの記事キャッシュ (`<workspace>/fable/ai-note-review/cache.json`) から記事の題・分類・最終レビュー日を読む。
 * 記事本文は読まない。 隔離アーカイブは cache 側で articles に入っていない前提 (quarantine は別の欄)。
 *
 * @implements spec/feature/parttimer-agent-dispatch.md — 読み取り adapter (AIノート)
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AiNoteArticle } from "../agent-jobs/ai-note-biweekly-review.js";

const PAGE_ID = /^[0-9a-f]{32}$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** 純関数: cache.json の中身から記事を取り出す。 形が違えば throw。 */
export function parseAiNoteCache(raw: unknown): AiNoteArticle[] {
  const articles = raw !== null && typeof raw === "object" ? (raw as { articles?: unknown }).articles : undefined;
  if (!Array.isArray(articles)) throw new Error("ai-note cache has no articles array");
  return articles.flatMap((article): AiNoteArticle[] => {
    if (article === null || typeof article !== "object") return [];
    const row = article as Record<string, unknown>;
    const title = text(row.title);
    if (!title) return [];
    const pageId = typeof row.page_id === "string" ? row.page_id.replace(/-/gu, "") : "";
    const lastReviewed = text(row.last_reviewed);
    return [{
      title,
      section: text(row.section),
      universality: text(row.universality),
      lastReviewed: lastReviewed && DATE.test(lastReviewed) ? lastReviewed : null,
      note: text(row.note),
      url: PAGE_ID.test(pageId) ? `https://www.notion.so/${pageId}` : null,
    }];
  });
}

export async function readAiNoteArticles(workspaceRoot: string): Promise<AiNoteArticle[]> {
  const content = await readFile(join(workspaceRoot, "fable", "ai-note-review", "cache.json"), "utf8");
  return parseAiNoteCache(JSON.parse(content) as unknown);
}
