/**
 * Notion のページの取得 — 公開ページのクロール (spec/feature/patrol-chat.md「知識」の「Notion 記事マップ」)。
 *
 * 公開ページ (*.notion.site) の HTML を取り、 本文と子ページのリンクを取り出す。 Canalis の src/crawl/notion-public
 * (Playwright で描画後の DOM を読む) の抽出規則を参考に、 Cc では HTML の文字列から決定的に取り出す (ブラウザは起動しない)。
 * - 本文: `.notion-page-content` の中 (無ければ body) のテキスト。 script / style は捨てる
 * - 子ページ: 同じ origin で、 パスの末尾が 32 桁のページ ID のリンク
 * - 最終更新は HTML から分からないので null (本文の指紋で差分を見る)
 * - 本文が取れない (クライアント描画で空・ボット確認画面) ときは null を返し、 呼び出し側が MCP に回す
 * - 要求の間は最低 334ms あける (NotionRateGate)
 */

import { createRateGate, type RateGate } from "./knowledge-notion.js";
import { normalizeNotionId } from "./notion-map-rules.js";
import type { FetchedNotionPage, NotionFetchLimits, NotionPageRef, NotionPageSource } from "./notion-source-types.js";

const PUBLIC_TIMEOUT_MS = 20_000;

/** 公開ページの URL か (*.notion.site)。 */
export function isPublicNotionUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && /(^|\.)notion\.site$/i.test(u.hostname);
  } catch {
    return false;
  }
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", "#39": "'" };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (m, e: string) => {
    if (e.startsWith("#x") || e.startsWith("#X")) return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (e.startsWith("#") && e !== "#39") return String.fromCodePoint(parseInt(e.slice(1), 10));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Cloudflare のボット確認画面の題か。 */
export function isBotChallengeTitle(title: string): boolean {
  return /^(just a moment|attention required|しばらくお待ちください)/i.test(title.trim());
}

export interface PublicExtraction {
  title: string;
  text: string;
  /** 子ページ・ページリンク (同じ origin、 末尾が 32 桁の ID)。 絶対 URL。 */
  links: string[];
}

/** HTML から題・本文・子ページのリンクを取り出す (純関数)。 */
export function extractPublicNotionPage(html: string, pageUrl: string): PublicExtraction {
  const rawTitle = decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim();
  const title = rawTitle.replace(/\s*[|–-]\s*Notion\s*$/i, "").trim() || rawTitle;
  const cleaned = html.replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, "");
  const start = cleaned.search(/class="[^"]*\bnotion-page-content\b/i);
  const scope = start >= 0 ? cleaned.slice(cleaned.lastIndexOf("<", start)) : (cleaned.match(/<body[\s\S]*<\/body>/i)?.[0] ?? cleaned);
  const text = decodeEntities(scope
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|blockquote|pre|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, ""))
    .replace(/[ \t ]+/g, " ")
    .split("\n").map((l) => l.trim()).filter(Boolean).join("\n");
  const links: string[] = [];
  let origin: string;
  let self: string;
  try {
    const u = new URL(pageUrl);
    origin = u.origin;
    self = u.origin + u.pathname;
  } catch {
    return { title, text, links };
  }
  for (const m of scope.matchAll(/<a\b[^>]*\bhref="([^"]+)"/gi)) {
    let u: URL;
    try {
      u = new URL(decodeEntities(m[1]!), pageUrl);
    } catch {
      continue;
    }
    const last = u.pathname.split("/").filter(Boolean).pop() ?? "";
    if (u.origin !== origin || !/[0-9a-f]{32}$/i.test(last)) continue;
    const abs = u.origin + u.pathname;
    if (abs !== self && !links.includes(abs)) links.push(abs);
  }
  return { title, text, links };
}

const clipBytes = (text: string, max: number) =>
  Buffer.from(text, "utf8").subarray(0, max).toString("utf8").replace(/�+$/, "");

export function createPublicNotionSource(deps: { fetchImpl?: typeof fetch; gate?: RateGate } = {}): NotionPageSource {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const gate = deps.gate ?? createRateGate();
  return {
    fetchPage: async (ref: NotionPageRef, limits: NotionFetchLimits): Promise<FetchedNotionPage | null> => {
      if (!isPublicNotionUrl(ref.url)) return null;
      await gate.wait();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PUBLIC_TIMEOUT_MS);
      let html: string;
      try {
        const res = await fetchImpl(ref.url!, { method: "GET", headers: { accept: "text/html" }, signal: controller.signal });
        if (!res.ok) return null;
        html = await res.text();
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
      const ex = extractPublicNotionPage(html, ref.url!);
      if (isBotChallengeTitle(ex.title) || !ex.text) return null;
      const children = ex.links.slice(0, limits.maxChildren)
        .map((url) => ({ id: normalizeNotionId(url.split("/").pop() ?? ""), url }))
        .filter((c): c is { id: string; url: string } => c.id !== null && c.id !== ref.id)
        .map((c) => ({ id: c.id, url: c.url, title: null }));
      return {
        id: ref.id,
        title: ex.title || ref.title || "(無題)",
        url: ref.url,
        lastEditedMs: null,
        text: clipBytes(ex.text, limits.pageTextBytes),
        children,
        links: [],
        via: "public",
      };
    },
  };
}
