import type { ExcubitorClient } from "../excubitor/client.js";

export interface GeniusCard {
  id: string;
  title: string;
  score: number;
  domain?: string;
  tags?: string[];
}

export interface GeniusClient {
  query(input: { text: string; categories: string[]; k: number }): Promise<GeniusCard[] | null>;
}

/** healthz + query を合わせた上限 (spec/feature/inquiry.md §10-1)。 */
const QUERY_BUDGET_MS = 2_000;

/**
 * Genius は人間の判断代行。Cc は catalog に宣言された URL だけを使い、
 * 不在・失敗時は呼び出し元が self_judge へ戻す。
 */
export class CatalogGeniusClient implements GeniusClient {
  constructor(private readonly excubitor: Pick<ExcubitorClient, "findService">, private readonly fetchImpl: typeof fetch = fetch) {}

  async query(input: { text: string; categories: string[]; k: number }): Promise<GeniusCard[] | null> {
    const url = await this.resolveUrl();
    if (!url) return null;
    // 予算は healthz + query の合計で 2s (spec §10-1)。 各要求に 2s ずつ与えると
    // Genius 不在時に呼び出し元が倍待たされる。
    const deadline = Date.now() + QUERY_BUDGET_MS;
    try {
      const health = await this.request(`${url}/healthz`, { method: "GET" }, deadline);
      if (!health.ok) return null;
      const response = await this.request(`${url}/api/clone/query`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }, deadline);
      if (!response.ok) return null;
      const body = await response.json() as { cards?: unknown };
      return Array.isArray(body.cards) ? body.cards.flatMap(asCard) : [];
    } catch {
      return null;
    }
  }

  private async resolveUrl(): Promise<string | null> {
    const service = await this.excubitor.findService("genius").catch(() => null);
    const provides = service?.catalog_snapshot?.provides;
    const value = typeof provides?.GENIUS_URL === "string" ? provides.GENIUS_URL.trim() : "";
    return /^https?:\/\//.test(value) ? value.replace(/\/+$/, "") : null;
  }

  private async request(url: string, init: RequestInit, deadline: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()));
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}

function asCard(value: unknown): GeniusCard[] {
  if (!value || typeof value !== "object") return [];
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || typeof row.title !== "string" || typeof row.score !== "number") return [];
  return [{ id: row.id, title: row.title, score: row.score, domain: typeof row.domain === "string" ? row.domain : undefined, tags: Array.isArray(row.tags) ? row.tags.filter((tag): tag is string => typeof tag === "string") : undefined }];
}
