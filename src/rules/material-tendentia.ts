/**
 * Tendentia の公開ランキング素材 adapter (spec/feature/patrol-chat.md §4).
 *
 * 入口は Tendentia の `GET /api/trend-crawler/overview` (`{ overview, busy }`)。
 * - 取得版 = sourceId + item.key + fetchedAt、 話題同一性 = sourceId + item.key
 * - 個人の interest / click / tendency は読まない (公開ランキングだけ)
 * - source.error / fetchedAt で鮮度を判定する。 busy は成功時刻にもエラーにも読み替えない
 * - Cc から refresh / crawl は起動しない (読むだけ)
 */

import {
  MATERIAL_LIMITS,
  MaterialSourceError,
  type Material,
  type MaterialSource,
  type SourcePage,
  type SourceQuery,
} from "./material-types.js";

export const TENDENTIA_SOURCE_ID = "tendentia-public-trends";
const SERVICE_CODE = "Td";
/** 公開ランキングなのでどの宛先にも出してよい。 */
const PUBLIC_SCOPE = "public";

interface OverviewItem {
  key?: unknown;
  title?: unknown;
  subtitle?: unknown;
  url?: unknown;
  metric?: unknown;
  rank?: unknown;
  firstSeenAt?: unknown;
}
interface OverviewSource {
  sourceId?: unknown;
  name?: unknown;
  fetchedAt?: unknown;
  error?: unknown;
  items?: unknown;
}
interface OverviewGenre {
  genre?: unknown;
  sources?: unknown;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * overview 応答を素材へ正規化する (pure)。 形が契約と違えば schema エラー。
 * error 付き source と fetchedAt の無い source は古い成功データの可能性があるので採らない。
 */
export function normalizeTendentiaOverview(body: unknown, observedAt: string): Material[] {
  const overview = (body as { overview?: { genres?: unknown } } | null)?.overview;
  if (!overview || !Array.isArray(overview.genres)) {
    throw new MaterialSourceError("schema", "tendentia overview: genres missing");
  }
  const out: Material[] = [];
  for (const g of overview.genres as OverviewGenre[]) {
    const genre = str(g?.genre);
    if (!genre || !Array.isArray(g.sources)) continue;
    for (const s of g.sources as OverviewSource[]) {
      const sourceId = str(s?.sourceId);
      const fetchedAt = str(s?.fetchedAt);
      if (!sourceId || !fetchedAt || s.error || !Array.isArray(s.items)) continue;
      const sourceName = str(s.name) ?? sourceId;
      for (const item of s.items as OverviewItem[]) {
        const key = str(item?.key);
        const title = str(item?.title);
        if (!key || !title) continue;
        const subtitle = str(item.subtitle);
        const metric = str(item.metric);
        const excerpt = [subtitle, metric ? `(${metric})` : null, `— ${sourceName}`].filter(Boolean).join(" ");
        out.push({
          sourceId: TENDENTIA_SOURCE_ID,
          itemId: `${sourceId}:${key}`,
          version: `${sourceId}:${key}:${fetchedAt}`,
          kind: "trend",
          serviceCode: SERVICE_CODE,
          featureKey: genre,
          occurredAt: str(item.firstSeenAt) ?? fetchedAt,
          observedAt,
          title: clip(title, 200),
          excerpt: clip(excerpt, MATERIAL_LIMITS.maxExcerptChars),
          ...(str(item.url) ? { url: str(item.url)! } : {}),
          scopeKey: PUBLIC_SCOPE,
          shareableTo: ["*"],
          tags: [genre],
        });
      }
    }
  }
  return out;
}

/** ジャンルごとの並びを保ったまま、 ジャンルを 1 件ずつ交互に並べる (決定的)。 */
export function interleaveByGenre(items: readonly Material[]): Material[] {
  const groups = new Map<string, Material[]>();
  for (const m of items) {
    const g = m.featureKey ?? m.tags?.[0] ?? "";
    const list = groups.get(g);
    if (list) list.push(m);
    else groups.set(g, [m]);
  }
  const queues = [...groups.values()];
  const out: Material[] = [];
  for (let i = 0; out.length < items.length; i++) {
    for (const q of queues) if (i < q.length) out.push(q[i]);
  }
  return out;
}

export interface TendentiaSourceDeps {
  /** Excubitor topology が配る `TENDENTIA_URL`。 無ければ not-configured。 */
  baseUrl: string | null;
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
}

export function makeTendentiaSource(deps: TendentiaSourceDeps): MaterialSource {
  const doFetch = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? MATERIAL_LIMITS.fetchTimeoutMs;
  const now = deps.now ?? (() => new Date());
  return {
    async list(query: SourceQuery): Promise<SourcePage> {
      if (!deps.baseUrl) throw new MaterialSourceError("not-configured", "TENDENTIA_URL is not set");
      const url = `${deps.baseUrl.replace(/\/+$/, "")}/api/trend-crawler/overview`;
      let res: Response;
      try {
        res = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        const name = (err as Error).name;
        if (name === "TimeoutError" || name === "AbortError") {
          throw new MaterialSourceError("timeout", `tendentia overview timed out after ${timeoutMs}ms`);
        }
        throw new MaterialSourceError("unavailable", `tendentia overview: ${(err as Error).message}`);
      }
      if (res.status === 401 || res.status === 403) {
        throw new MaterialSourceError("auth", `tendentia overview: HTTP ${res.status}`);
      }
      if (!res.ok) throw new MaterialSourceError("unavailable", `tendentia overview: HTTP ${res.status}`);
      const body = await res.json().catch(() => {
        throw new MaterialSourceError("schema", "tendentia overview: invalid JSON");
      });
      const observedAt = now().toISOString();
      const sinceMs = Date.parse(query.since);
      const filtered = normalizeTendentiaOverview(body, observedAt)
        .filter((m) => m.shareableTo.includes("*") || m.shareableTo.includes(query.scopeKey))
        .filter((m) => !query.featureKey || m.featureKey === query.featureKey)
        .filter((m) => !query.genres?.length || (m.tags ?? []).some((t) => query.genres!.includes(t)))
        .filter((m) => Number.isNaN(sinceMs) || Date.parse(m.occurredAt) >= sinceMs);
      // 上限はジャンルを交互に取ってから掛ける。 overview は総合ジャンルが先頭なので、
      // 先頭から切ると他のジャンル (ゲーム・技術など) が候補に入らない。
      const items = interleaveByGenre(filtered).slice(0, Math.min(query.limit, MATERIAL_LIMITS.maxItemsPerFetch));
      return { items, cursor: null, observedAt, status: items.length > 0 ? "ready" : "empty" };
    },
  };
}
