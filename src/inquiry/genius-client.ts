import type { ExcubitorClient } from "../excubitor/client.js";

export interface GeniusCard {
  id: string;
  /** Backward-compatible display label. Current Genius calls this `situation`. */
  title: string;
  score: number;
  domain?: string;
  category?: string | null;
  situation?: string;
  judgment?: string;
  rationale?: string;
  confidence?: number;
  tags?: string[];
}

export interface GeniusClient {
  query(input: { text: string; categories?: string[]; k: number }): Promise<GeniusCard[] | null>;
}

/** catalog 解決 + healthz + query を合わせた上限 (spec/feature/inquiry.md §10-1)。 */
const QUERY_BUDGET_MS = 2_000;

/**
 * Genius は人間の判断代行。Cc は catalog に宣言された URL だけを使い、
 * 不在・失敗時は呼び出し元が self_judge へ戻す。
 */
export class CatalogGeniusClient implements GeniusClient {
  constructor(private readonly excubitor: Pick<ExcubitorClient, "findService">, private readonly fetchImpl: typeof fetch = fetch) {}

  async query(input: { text: string; categories?: string[]; k: number }): Promise<GeniusCard[] | null> {
    const deadline = Date.now() + QUERY_BUDGET_MS;
    try {
      const url = await this.resolveUrl(deadline);
      if (!url || Date.now() >= deadline) return null;
      const health = await this.request(
        `${url}/healthz`,
        { method: "GET" },
        deadline,
        async (response) => response,
      );
      if (!health.ok || Date.now() >= deadline) return null;
      const result = await this.request(
        `${url}/api/clone/query`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
        deadline,
        async (response) => ({
          ok: response.ok,
          body: response.ok ? await response.json() as { cards?: unknown } : null,
        }),
      );
      if (!result.ok || !result.body) return null;
      const body = result.body;
      return Array.isArray(body.cards) ? body.cards.flatMap(asCard) : [];
    } catch {
      // Genius is optional; discovery, timeout, transport, and parse failures are fail-soft.
      return null;
    }
  }

  private async resolveUrl(deadline: number): Promise<string | null> {
    const remainingMs = Math.max(0, deadline - Date.now());
    if (remainingMs === 0) return null;
    const service = await this.excubitor.findService("genius", remainingMs).catch(() => null);
    const provides = service?.catalog_snapshot?.provides;
    const value = typeof provides?.GENIUS_URL === "string" ? provides.GENIUS_URL.trim() : "";
    return /^https?:\/\//.test(value) ? value.replace(/\/+$/, "") : null;
  }

  private async request<T>(
    url: string,
    init: RequestInit,
    deadline: number,
    consume: (response: Response) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()));
    try {
      // Query bodies can contain task text. Never forward them to a redirect target.
      const response = await this.fetchImpl(url, { ...init, redirect: "error", signal: controller.signal });
      return await consume(response);
    } finally {
      clearTimeout(timer);
    }
  }
}

function asCard(value: unknown): GeniusCard[] {
  if (!value || typeof value !== "object") return [];
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || typeof row.score !== "number") return [];
  const situation = typeof row.situation === "string" ? row.situation : undefined;
  const legacyTitle = typeof row.title === "string" ? row.title : undefined;
  const title = situation ?? legacyTitle;
  if (!title) return [];
  return [{
    id: row.id,
    title,
    score: row.score,
    domain: typeof row.domain === "string" ? row.domain : undefined,
    category: typeof row.category === "string" || row.category === null ? row.category : undefined,
    situation,
    judgment: typeof row.judgment === "string" ? row.judgment : undefined,
    rationale: typeof row.rationale === "string" ? row.rationale : undefined,
    confidence: typeof row.confidence === "number" ? row.confidence : undefined,
    tags: Array.isArray(row.tags) ? row.tags.filter((tag): tag is string => typeof tag === "string") : undefined,
  }];
}
