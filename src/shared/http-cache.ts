import type { MiddlewareHandler } from "hono";
import { createChildLogger } from "./logger.js";
import { readRedisJson, redisCacheKey, writeRedisJson } from "./redis-cache.js";

interface CachedHttpResponse {
  status: number;
  body: string;
  contentType: string | null;
  createdAt: number;
}

interface L1Entry {
  expiresAt: number;
  response: CachedHttpResponse;
}

const log = createChildLogger("http-cache");
const l1 = new Map<string, L1Entry>();
let nextL1Namespace = 0;
const MAX_L1_ENTRIES = readPositiveIntEnv("CONCORDIA_HTTP_CACHE_L1_MAX_ENTRIES", 500);
const MAX_BODY_BYTES = readPositiveIntEnv("CONCORDIA_HTTP_CACHE_MAX_BYTES", 2 * 1024 * 1024);

export function httpCacheMiddleware(): MiddlewareHandler {
  const l1Namespace = `app:${nextL1Namespace++}:`;
  return async (c, next) => {
    if (!httpCacheEnabled()) {
      await next();
      return;
    }
    if (c.req.method !== "GET") {
      await next();
      return;
    }
    const url = new URL(c.req.url);
    const ttlMs = cacheTtlMs(url.pathname);
    if (ttlMs === null) {
      await next();
      return;
    }
    if (cacheBypassed(c.req.header("cache-control"))) {
      await next();
      c.header("x-concordia-cache", "bypass");
      return;
    }

    const key = redisCacheKey(`http:v1:${url.pathname}${url.search}`);
    const localKey = `${l1Namespace}${key}`;
    const now = Date.now();
    const local = l1.get(localKey);
    if (local && local.expiresAt > now) {
      return cachedResponse(local.response, "l1");
    }
    if (local) l1.delete(localKey);

    if (httpCacheRedisReadEnabled()) {
      const fromRedis = await readRedisJson<CachedHttpResponse>(key);
      if (fromRedis) {
        l1.set(localKey, { response: fromRedis, expiresAt: now + ttlMs });
        trimL1();
        return cachedResponse(fromRedis, "redis");
      }
    }

    await next();

    if (c.res.status !== 200) return;
    const contentType = c.res.headers.get("content-type");
    if (!contentType?.includes("application/json")) return;

    const body = await c.res.clone().text();
    const bodyBytes = Buffer.byteLength(body);
    if (bodyBytes > MAX_BODY_BYTES) {
      const headers = new Headers(c.res.headers);
      headers.set("x-concordia-cache", "skip-size");
      headers.set("x-concordia-cache-body-bytes", String(bodyBytes));
      c.res = new Response(body, { status: c.res.status, headers });
      return;
    }

    const storedAt = Date.now();
    const payload: CachedHttpResponse = {
      status: c.res.status,
      body,
      contentType,
      createdAt: storedAt,
    };
    l1.set(localKey, { response: payload, expiresAt: storedAt + ttlMs });
    trimL1();
    void writeRedisJson(key, payload, ttlMs).catch((err: unknown) => {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, "http cache redis write failed");
    });

    const headers = new Headers(c.res.headers);
    headers.set("x-concordia-cache", "miss");
    headers.set("x-concordia-cache-ttl-ms", String(ttlMs));
    headers.set("x-concordia-cache-body-bytes", String(bodyBytes));
    c.res = new Response(body, { status: c.res.status, headers });
  };
}

export function clearHttpCacheForTest(): void {
  l1.clear();
}

function cachedResponse(cached: CachedHttpResponse, source: "l1" | "redis"): Response {
  const headers = new Headers();
  if (cached.contentType) headers.set("content-type", cached.contentType);
  headers.set("x-concordia-cache", source);
  headers.set("x-concordia-cache-age-ms", String(Math.max(0, Date.now() - cached.createdAt)));
  headers.set("x-concordia-cache-body-bytes", String(Buffer.byteLength(cached.body)));
  return new Response(cached.body, { status: cached.status, headers });
}

function httpCacheEnabled(): boolean {
  const raw = process.env.CONCORDIA_HTTP_CACHE_ENABLED;
  if (raw && /^(0|false|no)$/i.test(raw)) return false;
  if (raw && /^(1|true|yes)$/i.test(raw)) return true;
  return process.env.VITEST !== "true" && process.env.NODE_ENV !== "test";
}

function httpCacheRedisReadEnabled(): boolean {
  const raw = process.env.CONCORDIA_HTTP_CACHE_REDIS_READ;
  if (raw && /^(0|false|no)$/i.test(raw)) return false;
  return true;
}

function cacheBypassed(cacheControl: string | undefined): boolean {
  return /(?:^|,)\s*no-cache\s*(?:,|$)|(?:^|,)\s*no-store\s*(?:,|$)/i.test(cacheControl ?? "");
}

function cacheTtlMs(pathname: string): number | null {
  if (pathname === "/health") return null;
  if (pathname.startsWith("/v1/admin/")) return null;
  if (pathname.includes("/pending-tasks")) return null;
  if (pathname.includes("/fs/")) return null;

  if (pathname.startsWith("/v1/work/repos")) return null;
  if (pathname.startsWith("/v1/work/conversations")) return 750;
  if (pathname.startsWith("/v1/library")) return 10_000;
  if (pathname.startsWith("/v1/cost/timeseries")) return 5_000;
  if (pathname.startsWith("/v1/cost/limit-timeseries")) return 5_000;
  if (pathname.startsWith("/v1/cost/overview")) return 1_000;
  if (pathname.startsWith("/v1/cost/one-shots")) return 1_000;
  if (pathname.startsWith("/v1/monitor")) return 500;
  if (pathname.startsWith("/v1/prs")) return 2_000;
  if (pathname.startsWith("/v1/session-logs")) return 5_000;
  if (pathname.startsWith("/v1/delegation/templates")) return 5_000;
  if (pathname.startsWith("/v1/delegation/options")) return 5_000;
  if (pathname.startsWith("/v1/model-catalog")) return 5_000;
  if (pathname.startsWith("/v1/skills")) return 5_000;
  if (pathname.startsWith("/v1/chat")) return 500;
  if (pathname.startsWith("/v1/reports")) return 2_000;
  if (pathname.startsWith("/v1/stat")) return 1_000;
  if (pathname.startsWith("/v1/machines")) return 1_000;
  if (pathname.startsWith("/v1/tasks")) return 1_000;
  if (pathname.startsWith("/v1/subsidiaries")) return 1_000;
  if (pathname.startsWith("/v1/harness-rules")) return 5_000;
  if (pathname.startsWith("/v1/harness/audit")) return 1_000;
  if (pathname === "/v1/sessions") return 500;
  if (pathname.startsWith("/v1/sessions/")) return null;
  return null;
}

function trimL1(): void {
  while (l1.size > MAX_L1_ENTRIES) {
    const first = l1.keys().next().value as string | undefined;
    if (!first) return;
    l1.delete(first);
  }
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
