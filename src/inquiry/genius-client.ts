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

/** Fail fast when unavailable; a healthy service can need longer to load embeddings. */
const DISCOVERY_BUDGET_MS = 2_000;
const CARD_SEARCH_BUDGET_MS = 60_000;

/**
 * Genius は人間の判断代行。Cc は catalog に宣言された URL だけを使い、
 * 不在・失敗時は呼び出し元が self_judge へ戻す。
 */
export class CatalogGeniusClient implements GeniusClient {
  constructor(private readonly excubitor: Pick<ExcubitorClient, "findService" | "topologyValue">, private readonly fetchImpl: typeof fetch = fetch) {}

  async query(input: { text: string; categories?: string[]; k: number }): Promise<GeniusCard[] | null> {
    const deadline = Date.now() + DISCOVERY_BUDGET_MS;
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
        Date.now() + CARD_SEARCH_BUDGET_MS,
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
    let value = provides?.GENIUS_URL?.trim();
    if (value?.includes("${")) {
      const budget = deadline - Date.now();
      if (budget <= 0) return null;
      value = (await this.excubitor.topologyValue("GENIUS_URL", budget))?.trim();
    }
    if (!value || value.includes("${") || !/^https?:\/\//.test(value) || !URL.canParse(value)) return null;
    return value.replace(/\/+$/, "");
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
