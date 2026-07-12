export interface ExcubitorComponentLite {
  code: string;
  name: string;
  project_code: string;
  component: string | null;
  runtime: string | null;
  state: string | null;
  disabled: boolean;
  monitor_only: boolean;
}

export interface ExcubitorProjectLite {
  project_code: string;
  project_name: string;
  components: ExcubitorComponentLite[];
}

export interface ExcubitorProjectCacheLogger {
  info: (m: string) => void;
  warn: (m: string) => void;
}

export type ExcubitorProjectCacheSource = "cache" | "fresh" | "stale" | "empty";

export interface ExcubitorProjectCacheResult {
  projects: ExcubitorProjectLite[];
  source: ExcubitorProjectCacheSource;
  refreshing: boolean;
}

export type ExcubitorProjectsFetcher = (
  baseUrl: string,
  timeoutMs: number,
) => Promise<ExcubitorProjectLite[]>;

export const EXCUBITOR_PROJECT_CACHE_TTL_MS = 5 * 60 * 1000;
export const EXCUBITOR_PROJECT_CACHE_INITIAL_WAIT_MS = 800;

interface CacheEntry {
  projects: ExcubitorProjectLite[];
  fetchedAt: number;
}

export class ExcubitorProjectCache {
  private entry: CacheEntry | null = null;
  private inFlight: Promise<ExcubitorProjectLite[]> | null = null;
  private generation = 0;

  constructor(
    private readonly options: {
      ttlMs?: number;
      maxInitialWaitMs?: number;
      requestTimeoutMs?: number;
      fetcher?: ExcubitorProjectsFetcher;
      now?: () => number;
    } = {},
  ) {}

  async get(
    baseUrl: string,
    log: ExcubitorProjectCacheLogger,
    now = this.now(),
  ): Promise<ExcubitorProjectCacheResult> {
    const ttlMs = this.options.ttlMs ?? EXCUBITOR_PROJECT_CACHE_TTL_MS;
    const maxInitialWaitMs = this.options.maxInitialWaitMs ?? EXCUBITOR_PROJECT_CACHE_INITIAL_WAIT_MS;
    const entry = this.entry;
    if (entry && now - entry.fetchedAt < ttlMs) {
      return { projects: entry.projects, source: "cache", refreshing: this.inFlight !== null };
    }

    const refresh = this.startRefresh(baseUrl, log);
    if (entry) {
      return { projects: entry.projects, source: "stale", refreshing: true };
    }

    const fresh = await waitFor(refresh, maxInitialWaitMs);
    if (fresh) return { projects: fresh, source: "fresh", refreshing: false };
    return { projects: [], source: "empty", refreshing: true };
  }

  invalidate(): void {
    this.inFlight = null;
    this.generation++;
    if (this.entry) {
      this.entry = { projects: this.entry.projects, fetchedAt: Number.NEGATIVE_INFINITY };
    }
  }

  clear(): void {
    this.entry = null;
    this.inFlight = null;
    this.generation++;
  }

  private startRefresh(baseUrl: string, log: ExcubitorProjectCacheLogger): Promise<ExcubitorProjectLite[]> {
    if (this.inFlight) return this.inFlight;
    const timeoutMs = this.options.requestTimeoutMs ?? 5_000;
    const fetcher = this.options.fetcher ?? fetchExcubitorProjects;
    const gen = this.generation;
    const next = fetcher(baseUrl, timeoutMs)
      .then((projects) => {
        const sorted = [...projects].sort((a, b) => a.project_code.localeCompare(b.project_code));
        if (gen === this.generation) this.entry = { projects: sorted, fetchedAt: this.now() };
        return sorted;
      })
      .catch((err) => {
        log.warn(`excubitor project cache refresh failed: ${(err as Error).message}`);
        return this.entry?.projects ?? [];
      })
      .finally(() => {
        if (this.inFlight === next) this.inFlight = null;
      });
    this.inFlight = next;
    return this.inFlight;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

export const excubitorProjectCache = new ExcubitorProjectCache();

export function excubitorBaseUrl(): string {
  return (process.env.CONCORDIA_EXCUBITOR_URL || process.env.EXCUBITOR_URL || "http://127.0.0.1:17332").replace(/\/+$/, "");
}

export async function fetchExcubitorProjects(
  baseUrl: string,
  timeoutMs: number,
): Promise<ExcubitorProjectLite[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/api/v1/projects`, {
      method: "GET",
      headers: {
        "content-type": "application/json",
        "x-concordia-actor": "discord-command",
      },
      signal: controller.signal,
    });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as { projects?: unknown; error?: string }) : {};
    if (!res.ok) {
      throw new Error(json.error ?? `HTTP ${res.status}`);
    }
    if (!Array.isArray(json.projects)) return [];
    return json.projects.map(normalizeProject).filter((p): p is ExcubitorProjectLite => p !== null);
  } finally {
    clearTimeout(timer);
  }
}

function normalizeProject(raw: unknown): ExcubitorProjectLite | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const projectCode = stringValue(obj.project_code);
  if (!projectCode) return null;
  const projectName = stringValue(obj.project_name) || projectCode;
  const components = Array.isArray(obj.components)
    ? obj.components.map(normalizeComponent).filter((c): c is ExcubitorComponentLite => c !== null)
    : [];
  return { project_code: projectCode, project_name: projectName, components };
}

function normalizeComponent(raw: unknown): ExcubitorComponentLite | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const code = stringValue(obj.code);
  if (!code) return null;
  return {
    code,
    name: stringValue(obj.name) || code,
    project_code: stringValue(obj.project_code) || code,
    component: nullableString(obj.component),
    runtime: nullableString(obj.runtime),
    state: nullableString(obj.state),
    disabled: obj.disabled === true,
    monitor_only: obj.monitor_only === true,
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
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
