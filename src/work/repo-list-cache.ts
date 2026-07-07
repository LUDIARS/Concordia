import { createHash } from "node:crypto";
import type { SessionsRepo } from "../db/sessions-repo.js";
import { createChildLogger } from "../shared/logger.js";
import { readRedisJson, redisCacheKey, writeRedisJson } from "../shared/redis-cache.js";
import { scanReposMulti, type RepoStatus } from "./repo-scan.js";

export type WorkReposCacheSource = "l1" | "redis" | "redis-stale" | "stale" | "fresh" | "empty";

export interface CachedWorkRepos {
  version: 1;
  root: string;
  roots: string[];
  repos: RepoStatus[];
  createdAt: number;
  durationMs: number;
}

export interface WorkReposCacheResult {
  root: string;
  roots: string[];
  repos: RepoStatus[];
  refreshing: boolean;
  cache: {
    source: WorkReposCacheSource;
    age_ms: number | null;
    ttl_ms: number;
    stale_ms: number;
    generated_at: string | null;
    refresh_duration_ms: number | null;
  };
}

export interface WorkReposCacheOptions {
  sessions: SessionsRepo;
  fetcher?: (roots: readonly string[], sessions: SessionsRepo) => Promise<RepoStatus[]>;
  ttlMs?: number;
  staleMs?: number;
  initialWaitMs?: number;
  refreshDelayMs?: number;
  maxL1Entries?: number;
  now?: () => number;
}

const log = createChildLogger("work-repos-cache");

export class WorkReposCache {
  private readonly sessions: SessionsRepo;
  private readonly fetcher: (roots: readonly string[], sessions: SessionsRepo) => Promise<RepoStatus[]>;
  private readonly ttlMs: number;
  private readonly staleMs: number;
  private readonly initialWaitMs: number;
  private readonly refreshDelayMs: number;
  private readonly maxL1Entries: number;
  private readonly nowFn: () => number;
  private readonly l1 = new Map<string, CachedWorkRepos>();
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(options: WorkReposCacheOptions) {
    this.sessions = options.sessions;
    this.fetcher = options.fetcher ?? scanReposMulti;
    this.ttlMs = options.ttlMs ?? readPositiveIntEnv("CONCORDIA_WORK_REPOS_CACHE_TTL_MS", 3_000);
    this.staleMs = options.staleMs ?? readPositiveIntEnv("CONCORDIA_WORK_REPOS_CACHE_STALE_MS", 10 * 60_000);
    this.initialWaitMs =
      options.initialWaitMs ?? readNonNegativeIntEnv("CONCORDIA_WORK_REPOS_CACHE_INITIAL_WAIT_MS", 0);
    this.refreshDelayMs =
      options.refreshDelayMs ?? readNonNegativeIntEnv("CONCORDIA_WORK_REPOS_CACHE_REFRESH_DELAY_MS", 1_000);
    this.maxL1Entries = options.maxL1Entries ?? readPositiveIntEnv("CONCORDIA_WORK_REPOS_CACHE_L1_MAX", 16);
    this.nowFn = options.now ?? Date.now;
  }

  async get(roots: readonly string[], opts: { forceRefresh?: boolean } = {}): Promise<WorkReposCacheResult> {
    const normalizedRoots = normalizeRoots(roots);
    const cacheId = cacheIdFor(normalizedRoots);
    const local = this.l1.get(cacheId);
    const now = this.now();

    if (!opts.forceRefresh && local && this.isFresh(local, now)) {
      return this.toResult(local, "l1", false, now);
    }

    if (local && !this.isExpired(local, now)) {
      this.refresh(cacheId, normalizedRoots, this.refreshDelayMs);
      return this.toResult(local, "stale", true, now);
    }

    if (workReposRedisReadEnabled()) {
      const redisEntry = await readRedisJson<CachedWorkRepos>(redisKeyFor(cacheId));
      const cached = validateCachedWorkRepos(redisEntry);
      if (cached && !this.isExpired(cached, now)) {
        this.storeLocal(cacheId, cached);
        const fresh = this.isFresh(cached, now);
        if (!fresh || opts.forceRefresh) this.refresh(cacheId, normalizedRoots, this.refreshDelayMs);
        return this.toResult(cached, fresh ? "redis" : "redis-stale", !fresh || !!opts.forceRefresh, now);
      }
    }

    const refresh = this.refresh(cacheId, normalizedRoots, this.refreshDelayMs);
    const completed = await waitFor(
      refresh.then(() => this.l1.get(cacheId) ?? null),
      this.initialWaitMs,
    );
    if (completed) return this.toResult(completed, "fresh", false, this.now());

    return {
      root: normalizedRoots[0] ?? "",
      roots: normalizedRoots,
      repos: [],
      refreshing: true,
      cache: {
        source: "empty",
        age_ms: null,
        ttl_ms: this.ttlMs,
        stale_ms: this.staleMs,
        generated_at: null,
        refresh_duration_ms: null,
      },
    };
  }

  clear(): void {
    this.l1.clear();
    this.inFlight.clear();
  }

  private refresh(cacheId: string, roots: readonly string[], delayMs = 0): Promise<void> {
    const current = this.inFlight.get(cacheId);
    if (current) return current;

    const startedAt = this.now();
    const promise = delay(delayMs)
      .then(() => this.fetcher(roots, this.sessions))
      .then(async (repos) => {
        const finishedAt = this.now();
        const entry: CachedWorkRepos = {
          version: 1,
          root: roots[0] ?? "",
          roots: [...roots],
          repos,
          createdAt: finishedAt,
          durationMs: Math.max(0, finishedAt - startedAt),
        };
        this.storeLocal(cacheId, entry);
        await writeRedisJson(redisKeyFor(cacheId), entry, this.staleMs);
        log.info(
          { roots: roots.length, repos: repos.length, duration_ms: entry.durationMs },
          "work repos cache refreshed",
        );
      })
      .catch((err: unknown) => {
        log.warn(
          { err: err instanceof Error ? err.message : String(err), roots: roots.length },
          "work repos cache refresh failed",
        );
      })
      .finally(() => {
        this.inFlight.delete(cacheId);
      });
    this.inFlight.set(cacheId, promise);
    return promise;
  }

  private storeLocal(cacheId: string, entry: CachedWorkRepos): void {
    this.l1.set(cacheId, entry);
    while (this.l1.size > this.maxL1Entries) {
      const first = this.l1.keys().next().value as string | undefined;
      if (!first) return;
      this.l1.delete(first);
    }
  }

  private toResult(
    entry: CachedWorkRepos,
    source: WorkReposCacheSource,
    refreshing: boolean,
    now = this.now(),
  ): WorkReposCacheResult {
    return {
      root: entry.root,
      roots: entry.roots,
      repos: entry.repos,
      refreshing,
      cache: {
        source,
        age_ms: Math.max(0, now - entry.createdAt),
        ttl_ms: this.ttlMs,
        stale_ms: this.staleMs,
        generated_at: new Date(entry.createdAt).toISOString(),
        refresh_duration_ms: entry.durationMs,
      },
    };
  }

  private isFresh(entry: CachedWorkRepos, now: number): boolean {
    return now - entry.createdAt < this.ttlMs;
  }

  private isExpired(entry: CachedWorkRepos, now: number): boolean {
    return now - entry.createdAt >= this.staleMs;
  }

  private now(): number {
    return this.nowFn();
  }
}

function normalizeRoots(roots: readonly string[]): string[] {
  return roots.map((root) => root.trim()).filter(Boolean);
}

function cacheIdFor(roots: readonly string[]): string {
  return createHash("sha1").update(roots.join("\n")).digest("hex").slice(0, 16);
}

function redisKeyFor(cacheId: string): string {
  return redisCacheKey(`work:repos:v1:${cacheId}`);
}

function validateCachedWorkRepos(value: CachedWorkRepos | null): CachedWorkRepos | null {
  if (!value || typeof value !== "object") return null;
  if (value.version !== 1) return null;
  if (typeof value.root !== "string") return null;
  if (!Array.isArray(value.roots) || !Array.isArray(value.repos)) return null;
  if (!Number.isFinite(value.createdAt) || !Number.isFinite(value.durationMs)) return null;
  return value;
}

function waitFor<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  if (timeoutMs <= 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    timer.unref?.();
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

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function readNonNegativeIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function workReposRedisReadEnabled(): boolean {
  const raw = process.env.CONCORDIA_WORK_REPOS_CACHE_REDIS_READ;
  if (raw && /^(0|false|no)$/i.test(raw)) return false;
  return true;
}
