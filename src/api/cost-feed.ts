/**
 * /v1/cost-feed — クロスサービス cost-feed の ingest + 集計 API。
 *
 * Anatomia の POST/GET /api/cost-feed (Anatomia/src/adapters/web/routes/cost.ts)
 * を Concordia 側にも複製したもの。送信元サービス (Discutere 等) は同じコスト要約を
 * Anatomia と Concordia の両方へ push しうる。
 *
 * Routes:
 *   POST /v1/cost-feed   サービスから per-session コスト要約を取り込む
 *   GET  /v1/cost-feed   パネル用の集計レポート
 *
 * POST body:
 *   { service: string, ts?: number, sessions: [
 *       { sessionId, model?, backend?, calls, inputTokens, outputTokens,
 *         cacheReadTokens, cacheCreationTokens, costUsd }
 *   ] }
 *
 * 認証は loopback 想定で無し (他の Concordia API と同様)。
 * SRP: HTTP routing + 最小限の validation のみ。store は cost/cost-feed.ts、
 * 集計は cost/cost-feed-aggregate.ts。
 */

import { Hono } from "hono";
import { getCostFeed, type CostFeed, type CostFeedEntry } from "../cost/cost-feed.js";
import { aggregateCostFeed } from "../cost/cost-feed-aggregate.js";

interface IncomingRow {
  sessionId?: unknown;
  model?: unknown;
  backend?: unknown;
  calls?: unknown;
  inputTokens?: unknown;
  outputTokens?: unknown;
  cacheReadTokens?: unknown;
  cacheCreationTokens?: unknown;
  costUsd?: unknown;
}

interface IncomingBody {
  service?: unknown;
  ts?: unknown;
  sessions?: unknown;
}

export interface CostFeedApiDeps {
  /** 省略時は env 解決の singleton (getCostFeed)。テストでは memory feed を渡す。 */
  feed?: CostFeed;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export function costFeedRouter(deps: CostFeedApiDeps = {}): Hono {
  const feed = deps.feed ?? getCostFeed();
  const app = new Hono();

  app.post("/", async (c) => {
    let body: IncomingBody;
    try {
      body = (await c.req.json()) as IncomingBody;
    } catch {
      return c.json({ ok: false, error: "invalid json" }, 400);
    }
    const service = str(body.service)?.trim();
    if (!service) return c.json({ ok: false, error: "service required" }, 400);

    const rows = Array.isArray(body.sessions) ? (body.sessions as IncomingRow[]) : [];
    const ts = num(body.ts) || Date.now();

    let recorded = 0;
    for (const r of rows) {
      const sessionId = str(r?.sessionId)?.trim();
      if (!sessionId) continue;
      const entry: CostFeedEntry = {
        ts,
        service,
        sessionId,
        model: str(r.model),
        backend: str(r.backend),
        calls: num(r.calls),
        inputTokens: num(r.inputTokens),
        outputTokens: num(r.outputTokens),
        cacheReadTokens: num(r.cacheReadTokens),
        cacheCreationTokens: num(r.cacheCreationTokens),
        costUsd: num(r.costUsd),
      };
      feed.record(entry);
      recorded++;
    }
    await feed.flush();
    return c.json({ ok: true as const, recorded });
  });

  app.get("/", async (c) => {
    const entries = await feed.read();
    return c.json(aggregateCostFeed(entries));
  });

  return app;
}
