/**
 * Hono app factory.
 */

import { Hono } from "hono";
import { registerChatRoutes, type ChatDeps } from "./api/register-chat.js";
import { registerCoreRoutes, type CoreDeps } from "./api/register-core.js";
import { registerCostRoutes, type CostDeps } from "./api/register-cost.js";
import { registerWebRoutes } from "./api/register-web.js";
import { modulesRouter } from "./api/modules.js";
import { inboxRouter } from "./api/inbox.js";
import type { InboxItem } from "./inbox/read-model.js";
import { makeDiscordChannelDirectory } from "./discord/channel-directory.js";
import { httpCacheMiddleware } from "./shared/http-cache.js";
import { createChildLogger } from "./shared/logger.js";
import { installApiInstrumentation } from "./instrumentation.js";
import { listHaltedLoops } from "./shared/loop-bulkhead.js";
import { beginRequest, endRequest } from "./shared/inflight-requests.js";

export type AppDeps = Omit<CoreDeps, "channelDirectory"> & ChatDeps & CostDeps & {
  startedAt: string;
  /**
   * dist/ が src/ より古いまま稼働しているか (起動時に 1 度だけ判定した結果)。
   * 「main に入っているのに直らない」を health から見えるようにするためのもので、
   * 起動は止めない。 判定できなかった場合は呼び出し側で false として扱う。
   */
  buildStale: boolean;
  /**
   * backend 内で実際に起動したモジュール名。 GET /v1/modules が台帳と突き合わせる。
   * 渡さなければ空として扱い、 embedded 指定のモジュールが不一致として出る。
   */
  startedModules?: readonly string[];
  /**
   * 人間宛て未回答事項の一覧。 DB から読むので bootstrap が渡す。
   */
  inboxItems: () => InboxItem[];
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
    // 処理中のあいだ台帳に載せる。 イベントループが止まったとき、 停止監視がここから
    // 「その瞬間に走っていたリクエスト」 を名指しする ([[inflight-requests]])。
    const inFlight = beginRequest(c.req.method, c.req.path, started);
    try {
      await next();
    } finally {
      endRequest(inFlight);
    }
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

  app.get("/health", (c) =>
    c.json({
      ok: true,
      service: "concordia",
      version: process.env.EXCUBITOR_SERVICE_VERSION ?? "unavailable",
      started_at: deps.startedAt,
      halted_loops: listHaltedLoops(),
      // 稼働中の dist が src より古いか。 ok は落とさない — 動いてはいるので、
      // 「壊れている」ではなく「main と一致していないかもしれない」の報せ。
      build_stale: deps.buildStale,
    }),
  );

  // モジュール台帳の読み取り面。 lifecycle 操作は持たない (Excubitor が正本)。
  // 人間宛て未回答事項の統合一覧。 読み取り専用で、 回答は既存経路のまま。
  app.route("/v1/inbox", inboxRouter({ items: deps.inboxItems }));

  app.route("/v1/modules", modulesRouter({
    wiring: () => ({ startedEmbedded: deps.startedModules ?? [] }),
  }));

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
