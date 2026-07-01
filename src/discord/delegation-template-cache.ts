export interface DelegationTemplateLite {
  call_name: string;
  title: string;
  is_active: boolean;
  call_only: boolean;
  emoji: string;
}

export interface DelegationTemplateCacheLogger {
  info: (m: string) => void;
  warn: (m: string) => void;
}

export type DelegationTemplateCacheSource = "cache" | "fresh" | "stale" | "empty";

export interface DelegationTemplateCacheResult {
  templates: DelegationTemplateLite[];
  source: DelegationTemplateCacheSource;
  refreshing: boolean;
}

export type DelegationTemplateFetcher = (
  baseUrl: string,
  timeoutMs: number,
) => Promise<DelegationTemplateLite[]>;

export const DELEGATION_TEMPLATE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface CacheEntry {
  templates: DelegationTemplateLite[];
  fetchedAt: number;
}

export class DelegationTemplateCache {
  private entry: CacheEntry | null = null;
  private inFlight: Promise<DelegationTemplateLite[]> | null = null;

  constructor(
    private readonly options: {
      ttlMs?: number;
      maxInitialWaitMs?: number;
      requestTimeoutMs?: number;
      fetcher?: DelegationTemplateFetcher;
      now?: () => number;
    } = {},
  ) {}

  async get(
    baseUrl: string,
    log: DelegationTemplateCacheLogger,
    now = this.now(),
  ): Promise<DelegationTemplateCacheResult> {
    const ttlMs = this.options.ttlMs ?? DELEGATION_TEMPLATE_CACHE_TTL_MS;
    const maxInitialWaitMs = this.options.maxInitialWaitMs ?? 600;
    const entry = this.entry;
    if (entry && now - entry.fetchedAt < ttlMs) {
      return { templates: entry.templates, source: "cache", refreshing: false };
    }

    const refresh = this.refresh(baseUrl, log);
    if (entry) {
      return { templates: entry.templates, source: "stale", refreshing: true };
    }

    const fresh = await waitFor(refresh, maxInitialWaitMs);
    if (fresh) return { templates: fresh, source: "fresh", refreshing: false };
    return { templates: [], source: "empty", refreshing: true };
  }

  clear(): void {
    this.entry = null;
    this.inFlight = null;
  }

  private refresh(baseUrl: string, log: DelegationTemplateCacheLogger): Promise<DelegationTemplateLite[]> {
    if (this.inFlight) return this.inFlight;
    const timeoutMs = this.options.requestTimeoutMs ?? 5_000;
    const fetcher = this.options.fetcher ?? fetchDelegationTemplates;
    this.inFlight = fetcher(baseUrl, timeoutMs)
      .then((templates) => {
        this.entry = { templates, fetchedAt: this.now() };
        return templates;
      })
      .catch((err) => {
        log.warn(`delegation template cache refresh failed: ${(err as Error).message}`);
        return this.entry?.templates ?? [];
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

export const delegationTemplateCache = new DelegationTemplateCache();

export function invalidateDelegationTemplateCache(): void {
  delegationTemplateCache.clear();
}

export async function fetchDelegationTemplates(
  baseUrl: string,
  timeoutMs: number,
): Promise<DelegationTemplateLite[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/v1/delegation/templates`, {
      method: "GET",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
    });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as { templates?: DelegationTemplateLite[]; error?: string }) : {};
    if (!res.ok) {
      throw new Error(json.error ?? `HTTP ${res.status}`);
    }
    return Array.isArray(json.templates) ? json.templates : [];
  } finally {
    clearTimeout(timer);
  }
}

function waitFor<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}
