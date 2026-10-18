/**
 * Notion の知識の取り込み器 (spec/feature/patrol-chat.md「知識」)。
 *
 * - 公式 API: `POST /v1/search` (page のみ、 last_edited_time の新しい順) と `GET /v1/blocks/:id/children`
 * - 読むのは Cc 用の連携 (internal integration) に共有されたページだけ (search が返すもの)
 * - 差分取得: 前回の起点 (last_edited_time の最大値) より新しいページだけを読む。 全件取得は手動の取り直し
 * - レート制限: 平均 3 req/s を守るため、 要求の間を最低 334ms 空ける。 429 は Retry-After を待って 1 回だけ再送
 * - トークンは Authorization ヘッダにだけ載せ、 失敗理由・ログに出さない
 */

import { KNOWLEDGE_LIMITS, type KnowledgeCollector, type KnowledgeDoc } from "./knowledge-types.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:56548c81 */
import augurContract_126883c5 from './knowledge-notion.contract.js'; /* augur-inject:contract-predicate:b30305c2 */

export const NOTION_API_BASE = "https://api.notion.com/v1";
export const NOTION_VERSION = "2022-06-28";
/** 3 req/s。 */
export const NOTION_MIN_INTERVAL_MS = 334;

const NOTION_LIMITS = {
  maxPages: 200,
  maxBlocksPerPage: 300,
  maxDepth: 2,
  pageTextBytes: KNOWLEDGE_LIMITS.chunkBytes * KNOWLEDGE_LIMITS.maxChunksPerDoc,
  timeoutMs: 15_000,
} as const;

/** 直前の要求から最低間隔を空けるための待ち時間 (ms)。 純関数。 */
export function nextDelayMs(lastRequestAtMs: number | null, nowMs: number, minIntervalMs: number): number {
  if (lastRequestAtMs === null) return 0;
  return Math.max(0, lastRequestAtMs + minIntervalMs - nowMs);
}
// @ts-expect-error augur-inject
nextDelayMs = contract(nextDelayMs, { ...augurContract_126883c5, contractId: 'chat-knowledge-C-5', mode: 'observe', sample: 1, where: 'src/rules/knowledge-notion.ts:27', rule: 'contract-wrap', id: '126883c5' }); /* augur-inject:contract-wrap:126883c5 */

export class NotionRequestError extends Error {
  constructor(message: string, readonly code: "auth" | "rate_limited" | "http" | "timeout" | "invalid_response") {
    super(message);
  }
}

export interface NotionDeps {
  token: () => string | null;
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface NotionPage {
  id: string;
  url: string | null;
  title: string;
  lastEditedMs: number | null;
}

function pageTitle(page: Record<string, unknown>): string {
  const props = (page.properties ?? {}) as Record<string, { type?: string; title?: Array<{ plain_text?: string }> }>;
  for (const prop of Object.values(props)) {
    if (prop?.type === "title" && Array.isArray(prop.title)) {
      return prop.title.map((t) => t.plain_text ?? "").join("").trim();
    }
  }
  return "";
}

function toPage(item: unknown): NotionPage | null {
  if (!item || typeof item !== "object") return null;
  const page = item as Record<string, unknown>;
  if (page.object !== "page" || typeof page.id !== "string") return null;
  if (page.archived === true || page.in_trash === true) return null;
  const edited = typeof page.last_edited_time === "string" ? Date.parse(page.last_edited_time) : NaN;
  return {
    id: page.id,
    url: typeof page.url === "string" ? page.url : null,
    title: pageTitle(page) || "(無題)",
    lastEditedMs: Number.isFinite(edited) ? edited : null,
  };
}

/** block 1 件の文字。 rich_text を持つ型 (段落・見出し・箇条書き・引用・ToDo・コールアウト等) だけを読む。 */
function blockText(block: Record<string, unknown>): string {
  const type = typeof block.type === "string" ? block.type : "";
  const body = block[type] as { rich_text?: Array<{ plain_text?: string }> } | undefined;
  if (!body || !Array.isArray(body.rich_text)) return "";
  return body.rich_text.map((t) => t.plain_text ?? "").join("").trim();
}

export function createNotionCollector(deps: NotionDeps): KnowledgeCollector {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const nowMs = deps.nowMs ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastRequestAt: number | null = null;

  const request = async (token: string, path: string, init: { method: "GET" | "POST"; body?: unknown }, retried = false): Promise<unknown> => {
    const wait = nextDelayMs(lastRequestAt, nowMs(), NOTION_MIN_INTERVAL_MS);
    if (wait > 0) await sleep(wait);
    lastRequestAt = nowMs();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NOTION_LIMITS.timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(`${NOTION_API_BASE}${path}`, {
        method: init.method,
        headers: {
          authorization: `Bearer ${token}`,
          "notion-version": NOTION_VERSION,
          ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: controller.signal,
      });
    } catch (err) {
      throw new NotionRequestError(
        (err as Error).name === "AbortError" ? "notion request timed out" : "notion request failed (unreachable)",
        "timeout",
      );
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 429 && !retried) {
      const after = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 60) * 1000 : 1000);
      return request(token, path, init, true);
    }
    if (res.status === 401 || res.status === 403) throw new NotionRequestError(`notion rejected the token (http ${res.status})`, "auth");
    if (res.status === 429) throw new NotionRequestError("notion rate limited (http 429)", "rate_limited");
    if (!res.ok) throw new NotionRequestError(`notion http ${res.status}`, "http");
    try {
      return await res.json();
    } catch {
      throw new NotionRequestError("notion returned invalid JSON", "invalid_response");
    }
  };

  /** 共有されたページを新しい順に読み、 起点 (sinceMs) 以前に届いたら止める。 */
  const searchPages = async (token: string, sinceMs: number | null): Promise<NotionPage[]> => {
    const pages: NotionPage[] = [];
    let cursor: string | null = null;
    for (;;) {
      const body = await request(token, "/search", {
        method: "POST",
        body: {
          filter: { property: "object", value: "page" },
          sort: { direction: "descending", timestamp: "last_edited_time" },
          page_size: 100,
          ...(cursor ? { start_cursor: cursor } : {}),
        },
      }) as { results?: unknown[]; has_more?: boolean; next_cursor?: string | null };
      if (!Array.isArray(body?.results)) throw new NotionRequestError("notion search returned no results array", "invalid_response");
      for (const item of body.results) {
        const page = toPage(item);
        if (!page) continue;
        if (sinceMs !== null && page.lastEditedMs !== null && page.lastEditedMs <= sinceMs) return pages;
        pages.push(page);
        if (pages.length >= NOTION_LIMITS.maxPages) return pages;
      }
      if (!body.has_more || !body.next_cursor) return pages;
      cursor = body.next_cursor;
    }
  };

  /** ページ本文をテキストにする。 子 block は maxDepth 段まで、 合計 maxBlocksPerPage 件・pageTextBytes まで。 */
  const pageText = async (token: string, pageId: string): Promise<string> => {
    const lines: string[] = [];
    let blocks = 0;
    let bytes = 0;
    const walk = async (blockId: string, depth: number): Promise<void> => {
      let cursor: string | null = null;
      for (;;) {
        const query: string = `?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`;
        const body = await request(token, `/blocks/${encodeURIComponent(blockId)}/children${query}`, { method: "GET" }) as
          { results?: unknown[]; has_more?: boolean; next_cursor?: string | null };
        if (!Array.isArray(body?.results)) throw new NotionRequestError("notion blocks returned no results array", "invalid_response");
        for (const item of body.results) {
          if (blocks >= NOTION_LIMITS.maxBlocksPerPage || bytes >= NOTION_LIMITS.pageTextBytes) return;
          blocks += 1;
          const block = (item ?? {}) as Record<string, unknown>;
          const text = blockText(block);
          if (text) {
            lines.push(text);
            bytes += Buffer.byteLength(text, "utf8") + 1;
          }
          if (block.has_children === true && typeof block.id === "string" && depth + 1 < NOTION_LIMITS.maxDepth) {
            await walk(block.id, depth + 1);
          }
        }
        if (!body.has_more || !body.next_cursor) return;
        cursor = body.next_cursor;
      }
    };
    await walk(pageId, 0);
    return lines.join("\n");
  };

  return async ({ cursor, full }) => {
    const token = deps.token()?.trim();
    if (!token) return { notConfigured: "notion token is not set" };
    const sinceMs = !full && cursor ? Date.parse(cursor) : NaN;
    const pages = await searchPages(token, Number.isFinite(sinceMs) ? sinceMs : null);
    const docs: KnowledgeDoc[] = [];
    for (const page of pages) {
      docs.push({
        docType: "notion-page",
        docKey: `notion:${page.id}`,
        title: page.title,
        url: page.url,
        repo: null,
        path: null,
        // Notion の断片は常に本社限定
        scope: "hq",
        text: await pageText(token, page.id),
        sourceUpdatedAt: page.lastEditedMs === null ? null : Math.floor(page.lastEditedMs / 1000),
      });
    }
    const newest = pages.reduce<number | null>((max, p) => (p.lastEditedMs !== null && (max === null || p.lastEditedMs > max) ? p.lastEditedMs : max), null);
    const nextCursor = newest !== null ? new Date(Math.max(newest, Number.isFinite(sinceMs) ? sinceMs : 0)).toISOString() : cursor;
    return { docs, full: !Number.isFinite(sinceMs), cursor: nextCursor };
  };
}
