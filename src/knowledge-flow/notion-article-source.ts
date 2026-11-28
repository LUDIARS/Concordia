/**
 * ナレッジフローの記事 URL のうち Notion のページの判定 (spec/feature/slack-knowledge-flow.md KF-6/KF-7)。
 *
 * Notion の URL (notion.so / *.notion.site) は Canalis で取らず、 Claude の claude.ai Notion コネクタの委託で読む
 * (article-delegation.ts)。 Notion への書き込みはしない (MELPOT は Slack のスレッドへの投稿だけ。 2026-11-28 指示)。
 */

import { normalizeNotionId } from "../rules/notion-map-rules.js";

/** Notion のページ URL (ページ ID を含む) なら true。 */
export function isNotionSource(value: string): boolean {
    const url = URL.canParse(value) ? new URL(value) : undefined;
    if (!url || url.protocol !== "https:" || url.username || url.password || url.port) return false;
    const host = url.hostname.toLowerCase();
    const notion = host === "notion.so" || host === "www.notion.so" || host.endsWith(".notion.site");
    return notion && normalizeNotionId(url.pathname + url.search) !== null;
}
