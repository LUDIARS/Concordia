/**
 * Hono app factory.
 */

import { Hono } from "hono";
import { registerChatRoutes, type ChatDeps } from "./api/register-chat.js";
import { registerCoreRoutes, type CoreDeps } from "./api/register-core.js";
import { registerCostRoutes, type CostDeps } from "./api/register-cost.js";
import { registerWebRoutes } from "./api/register-web.js";
import { makeDiscordChannelDirectory } from "./discord/channel-directory.js";
import { adminAuthMiddleware } from "./shared/admin-auth.js";
import { httpCacheMiddleware } from "./shared/http-cache.js";
import { createChildLogger } from "./shared/logger.js";
import { installApiInstrumentation } from "./instrumentation.js";
import { listHaltedLoops } from "./shared/loop-bulkhead.js";
import { principalMiddleware, requireCapability } from "./auth/principal.js";

export type AppDeps = Omit<CoreDeps, "channelDirectory"> & ChatDeps & CostDeps & {
  startedAt: string;
  chatRoutes?: ChatDeps | null;
  costRoutes?: CostDeps | null;
};

export function buildApp(deps: AppDeps): Hono {
  const app = new Hono();
  installApiInstrumentation(app);
  const requestLog = createChildLogger("http");
  const perfLog = createChildLogger("perf");
  const slowRequestMs = readPositiveIntEnv("CONCORDIA_HTTP_SLOW_MS", 60);
  const perfRequestMs = readNonNegativeIntEnv("CONCORDIA_HTTP_PERF_LOG_MS", slowRequestMs);
  const logAllRequests = readBoolEnv("CONCORDIA_HTTP_LOG_ALL", false);
  const logQuery = readBoolEnv("CONCORDIA_HTTP_LOG_QUERY", false);

  app.use("*", async (c, next) => {
    const started = Date.now();
    await next();
    const elapsedMs = Date.now() - started;
    const cache = c.res.headers.get("x-concordia-cache");
    const cacheTtlMs = c.res.headers.get("x-concordia-cache-ttl-ms");
    const cacheAgeMs = c.res.headers.get("x-concordia-cache-age-ms");
    const cacheBodyBytes = c.res.headers.get("x-concordia-cache-body-bytes");
    const workReposCache = c.res.headers.get("x-concordia-work-repos-cache");
    const query = logQuery ? safeUrlSearch(c.req.url) : "";
    const requestDetails = {
      method: c.req.method,
      path: c.req.path,
      query: query || undefined,
      status: c.res.status,
      duration_ms: elapsedMs,
      cache: cache ?? undefined,
      cache_ttl_ms: parseHeaderInt(cacheTtlMs),
      cache_age_ms: parseHeaderInt(cacheAgeMs),
      body_bytes: parseHeaderInt(cacheBodyBytes),
      work_repos_cache: workReposCache ?? undefined,
    };
    const logRequest =
      logAllRequests ||
      c.req.path === "/health" ||
      elapsedMs >= slowRequestMs ||
      cache === "miss" ||
      cache === "bypass" ||
      cache === "skip-size";
    if (logRequest) {
      const line = [
        `request ${c.req.method} ${c.req.path}${query}`,
        `status=${c.res.status}`,
        `duration_ms=${elapsedMs}`,
        cache ? `cache=${cache}` : "",
        cacheTtlMs ? `cache_ttl_ms=${cacheTtlMs}` : "",
        cacheAgeMs ? `cache_age_ms=${cacheAgeMs}` : "",
        cacheBodyBytes ? `body_bytes=${cacheBodyBytes}` : "",
        workReposCache ? `work_repos_cache=${workReposCache}` : "",
      ].filter(Boolean).join(" ");
      if (elapsedMs >= slowRequestMs) requestLog.warn(line);
      else requestLog.info(line);
    }
    if (elapsedMs >= perfRequestMs) {
      perfLog.warn(requestDetails, "http request exceeded perf threshold");
    }
  });
  app.use("*", httpCacheMiddleware());

  // Every request receives an explicit principal. Anonymous remains a real,
  // least-privilege principal instead of being represented by an empty token.
  app.use("*", principalMiddleware(() => deps.config.adminToken));

  const adminAuth = adminAuthMiddleware(() => deps.config.adminToken);
  app.use("/v1/admin/*", adminAuth);
  app.use("/v1/sweeper/run", adminAuth);
  app.use("/v1/sessions/:id/inject", adminAuth);
  app.use("/v1/delegation/invoke", adminAuth);
  const chatWrite = requireCapability("chat:write");
  if (deps.chatRoutes !== null) {
    app.use("/v1/chat", async (c, next) => c.req.method === "GET" ? next() : chatWrite(c, next));
    app.use("/v1/chat/*", async (c, next) => c.req.method === "GET" ? next() : chatWrite(c, next));
  }
  app.use("/v1/confirm/*", async (c, next) => {
    if (c.req.method === "GET") return next();
    return requireCapability("release:confirm")(c, next);
  });
  app.use("/v1/processes/*", async (c, next) => {
    if (c.req.method === "GET") return next();
    return requireCapability("process:control")(c, next);
  });
  app.use("/v1/sessions/:id", async (c, next) => {
    if (c.req.method !== "DELETE") return next();
    return requireCapability("session:control")(c, next);
  });
  // Deny by default for every remaining state-changing API. The two bootstrap
  // entrances authenticate with narrower, one-time credentials in their route
  // handlers: /v1/spawn uses the repository spawn token and POST /v1/sessions
  // consumes concordia_spawn_id enrollment.
  app.use("/v1/*", async (c, next) => {
    if (isReadOnlyMethod(c.req.method) || isSelfAuthenticatingBootstrap(c.req.method, c.req.path)) {
      return next();
    }
    return requireCapability(capabilityForMutation(c.req.path))(c, next);
  });

  app.get("/health", (c) =>
    c.json({
      ok: true,
      service: "concordia",
      version: "0.1.0",
      started_at: deps.startedAt,
      halted_loops: listHaltedLoops(),
    }),
  );

  registerCoreRoutes(app, {
    ...deps,
    channelDirectory: makeDiscordChannelDirectory({
      pendingQuestions: deps.pendingQuestions,
      sessionChannels: deps.discordChannels,
      config: deps.discordConfig,
    }),
  });
  if (deps.chatRoutes !== null) registerChatRoutes(app, deps.chatRoutes ?? deps);
  if (deps.costRoutes !== null) registerCostRoutes(app, deps.costRoutes ?? deps);
  registerWebRoutes(app);

  return app;
}

function isReadOnlyMethod(method: string): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

function isSelfAuthenticatingBootstrap(method: string, path: string): boolean {
  return method === "POST" && (path === "/v1/spawn" || path === "/v1/sessions");
}

function capabilityForMutation(path: string) {
  if (path === "/v1/chat" || path.startsWith("/v1/chat/")) return "chat:write" as const;
  if (path.startsWith("/v1/confirm/")) return "release:confirm" as const;
  if (path.startsWith("/v1/processes/")) return "process:control" as const;
  if (path.startsWith("/v1/sessions/")) return "session:control" as const;
  return "admin:write" as const;
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

function readBoolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  if (/^(0|false|no|off)$/i.test(raw)) return false;
  return fallback;
}

function parseHeaderInt(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.floor(parsed) : undefined;
}

function safeUrlSearch(rawUrl: string): string {
  try {
    return new URL(rawUrl).search;
  } catch {
    return "";
  }
}
