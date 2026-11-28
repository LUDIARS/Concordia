/**
 * ナレッジフローの記事本文 — Notion のページ (spec/feature/slack-knowledge-flow.md KF-6)。
 *
 * Notion の URL (notion.so / *.notion.site) は Canalis で取らず、 Claude の claude.ai Notion コネクタで読む。
 * 取得は巡回チャットの知識と同じ MCP 経路 (rules/notion-source-mcp.ts) を使い、 読み取りツールだけを許す。
 * Notion への書き込みはしない (MELPOT は Slack のスレッドへの投稿だけ。 2026-11-28 指示)。
 */

import { createHash } from "node:crypto";
import { normalizeNotionId } from "../rules/notion-map-rules.js";
import { createMcpNotionSource, type NotionToolRunner } from "../rules/notion-source-mcp.js";

/** 記事 1 件の本文の上限。 子ページは辿らない。 */
const ARTICLE_LIMITS = { pageTextBytes: 200_000, maxChildren: 0 } as const;

function notionUrl(value: string): URL | undefined {
    const url = URL.canParse(value) ? new URL(value) : undefined;
    if (!url || url.protocol !== "https:" || url.username || url.password || url.port) return;
    const host = url.hostname.toLowerCase();
    if (host === "notion.so" || host === "www.notion.so" || host.endsWith(".notion.site")) return url;
}

/** Notion のページ URL (ページ ID を含む) なら true。 */
export function isNotionSource(value: string): boolean {
    const url = notionUrl(value);
    return Boolean(url && normalizeNotionId(url.pathname + url.search));
}

/** Claude の Notion コネクタでページ本文を読む。 読めなければ例外 (ワーカーが取得失敗として数える)。 */
export async function readNotionSource(value: string, runner: NotionToolRunner) {
    const url = notionUrl(value);
    const id = url ? normalizeNotionId(url.pathname + url.search) : null;
    if (!url || !id) throw new Error("Invalid Notion source");
    const page = await createMcpNotionSource({ runner }).fetchPage({ id, url: url.href }, ARTICLE_LIMITS);
    const text = page?.text.trim();
    if (!page || !text) throw new Error("Notion page unavailable");
    return { url: value, title: page.title, text, fetchedAt: new Date().toISOString(),
        hash: createHash("sha256").update(text).digest("hex") };
}
