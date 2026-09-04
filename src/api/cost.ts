/**
 * /v1/cost — WebUI の /cost ページ用の自セッションコスト API。
 *
 * クロスサービス feed (/v1/cost-feed) とは別系統で、 Concordia 自身が回している
 * セッションの使用量を出す:
 *   GET /v1/cost/overview     本社/子会社別 (日次・週間) + チャンネル別 (現在の context/cost)
 *                             = Discord の「Concordia Monitor」「コスト」チャンネルと同じ内容
 *   GET /v1/cost/timeseries   10 分毎サンプルを時刻バケットに畳んだ折れ線グラフ用系列
 *
 * SRP: HTTP routing のみ。 集計は cost/org-cost・channel-cost・usage-timeseries。
 */

import { Hono } from "hono";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { CostUsageSamplesRepo } from "../db/cost-usage-samples-repo.js";
import type { CostLimitSamplesRepo } from "../db/cost-limit-samples-repo.js";
import type { CostOneShotCallsRepo, CostOneShotStatus } from "../db/cost-one-shot-calls-repo.js";
import { collectOrgCostWindows, type OrgCostSubsidiary } from "../cost/org-cost.js";
import { cachedSessionWindowReader } from "../cost/windowed-usage-cache.js";
import { cachedChannelCostReader } from "../cost/channel-cost-cache.js";
import { collectChannelCostRows } from "../cost/channel-cost.js";
import type { CostReport } from "../cost/cost-report.js";
import { aggregateUsageTimeseries } from "../cost/usage-timeseries.js";
import { aggregateLimitTimeseries, collectLimitSamples } from "../cost/limit-sampler.js";
import { collectSampledCostOverview } from "../cost/sample-overview.js";
import { createChildLogger } from "../shared/logger.js";

const log = createChildLogger("cost-api");

export interface CostApiDeps {
  sessions: SessionsRepo;
  resolveSessionChannelId: (sessionId: string) => string | null;
  samples: CostUsageSamplesRepo;
  limitSamples: CostLimitSamplesRepo;
  oneShots: CostOneShotCallsRepo;
  overviewSource?: "live" | "samples";
  /** 本社モニターと同じ子会社一覧 (本社=未タグは内部で算出)。 */
  listSubsidiaries: () => OrgCostSubsidiary[];
}

export function costRouter(deps: CostApiDeps): Hono {
  const app = new Hono();

  app.get("/overview", async (c) => {
    const started = Date.now();
    const marks: Record<string, number> = {};
    const mark = (name: string, since: number): number => {
      const now = Date.now();
      marks[name] = now - since;
      return now;
    };
    const subs = deps.listSubsidiaries();
    let t = mark("listSubsidiariesMs", started);
    if (deps.overviewSource === "samples") {
      const body = collectSampledCostOverview({
        sessions: deps.sessions,
        samples: deps.samples,
        subsidiaries: subs,
        resolveSessionChannelId: deps.resolveSessionChannelId,
      });
      mark("collectSampledCostOverviewMs", t);
      logTiming("/overview", started, {
        source: "samples",
        channels: body.channels.length,
        subsidiaries: subs.length,
        ...marks,
      });
      return c.json(body);
    }
    let orgProfile: unknown = null;
    // memo 化 reader: 変化のないログ (終了済みセッション等) の再読みとパス再解決を
    // 省き、 同期 I/O でイベントループを長時間塞ぐのを防ぐ (実測 26s → ms オーダー)。
    const windows = await collectOrgCostWindows(deps.sessions, subs, Date.now(), cachedSessionWindowReader, {
      onProfile: (profile) => {
        orgProfile = {
          sessions: profile.sessions,
          readMs: profile.readMs,
          slowReads: profile.slowReads.slice(0, 10),
        };
      },
    });
    t = mark("collectOrgCostWindowsMs", t);
    const active = deps.sessions.listSessions({ status: "active" });
    t = mark("listActiveSessionsMs", t);
    // context/cost も memo + tail/増分読み (旧: findCodexLog 全走査 ×2 + 全行読みで
    // active 12 セッション ≈ 16 秒のイベントループ停止)。
    const channels = await collectChannelCostRows(active, deps.resolveSessionChannelId, cachedChannelCostReader);
    mark("collectChannelCostRowsMs", t);
    const body = { windows, channels };
    logTiming("/overview", started, {
      activeSessions: active.length,
      channels: channels.length,
      subsidiaries: subs.length,
      ...marks,
      orgProfile,
    });
    return c.json(body);
  });

  app.get("/timeseries", (c) => {
    const started = Date.now();
    const nowSec = Math.floor(Date.now() / 1000);
    const sinceQ = Number(c.req.query("since"));
    const bucketQ = Number(c.req.query("bucket"));
    // 既定: 直近 24h・10 分バケット。 since は epoch 秒 (0 = 全期間)。 未指定/NaN は 24h 前。
    const sinceSec = Number.isFinite(sinceQ) && sinceQ >= 0 ? Math.floor(sinceQ) : nowSec - 24 * 3600;
    const bucketSec = Number.isFinite(bucketQ) && bucketQ > 0 ? Math.floor(bucketQ) : 600;
    const rows = deps.samples.listSince(sinceSec);
    const body = aggregateUsageTimeseries(rows, bucketSec);
    logTiming("/timeseries", started, { rows: rows.length, points: body.points.length, providerPoints: body.providerPoints.length, bucketSec });
    return c.json(body);
  });

  app.get("/limit-timeseries", async (c) => {
    const started = Date.now();
    const nowSec = Math.floor(Date.now() / 1000);
    const sinceQ = Number(c.req.query("since"));
    const sinceSec = Number.isFinite(sinceQ) && sinceQ >= 0 ? Math.floor(sinceQ) : nowSec - 7 * 24 * 3600;
    const rows = deps.limitSamples.listSince(sinceSec);
    const previous = deps.limitSamples.listLatestByProvider();
    const latest = collectLimitSamples(emptyCostReport(), nowSec).map((s, i) => ({
      id: -1 - i,
      ...s,
    }));
    const body = aggregateLimitTimeseries([...rows, ...latest]);
    logTiming("/limit-timeseries", started, { rows: rows.length, latest: latest.length, points: body.points.length });
    return c.json(body);
  });

  app.post("/one-shots", async (c) => {
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) return c.json({ ok: false, error: "invalid json" }, 400);
    const service = typeof body.service === "string" ? body.service.trim() : "";
    const provider = typeof body.provider === "string" ? body.provider.trim() : "";
    const prompt = typeof body.prompt === "string" ? body.prompt : "";
    if (!service) return c.json({ ok: false, error: "service required" }, 400);
    if (!provider) return c.json({ ok: false, error: "provider required" }, 400);
    if (!prompt) return c.json({ ok: false, error: "prompt required" }, 400);

    let metadata_json = "{}";
    if (body.metadata && typeof body.metadata === "object") {
      metadata_json = JSON.stringify(body.metadata);
    } else if (typeof body.metadata_json === "string") {
      metadata_json = body.metadata_json;
    }

    const inputTokens = num(body.input_tokens);
    const outputTokens = num(body.output_tokens);
    const totalTokens = typeof body.total_tokens === "number" && Number.isFinite(body.total_tokens)
      ? body.total_tokens
      : inputTokens + outputTokens;
    const id = deps.oneShots.insert({
      ts: typeof body.ts === "number" && Number.isFinite(body.ts) ? body.ts : Date.now(),
      service,
      provider,
      command: typeof body.command === "string" ? body.command : "",
      model: typeof body.model === "string" ? body.model : null,
      cwd: typeof body.cwd === "string" ? body.cwd : null,
      prompt,
      status: parseStatus(body.status),
      exit_code: typeof body.exit_code === "number" ? body.exit_code : null,
      duration_ms: typeof body.duration_ms === "number" ? body.duration_ms : null,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: totalTokens,
      cost_usd: typeof body.cost_usd === "number" && Number.isFinite(body.cost_usd) ? body.cost_usd : 0,
      metadata_json,
    });
    return c.json({ ok: true, id });
  });

  app.get("/one-shots", (c) => {
    const limitQ = Number(c.req.query("limit"));
    const sinceQ = Number(c.req.query("since"));
    const limit = Number.isFinite(limitQ) && limitQ > 0 ? Math.floor(limitQ) : 100;
    const sinceMs = Number.isFinite(sinceQ) && sinceQ >= 0 ? Math.floor(sinceQ) : Date.now() - 24 * 3600 * 1000;
    return c.json({
      calls: deps.oneShots.listRecent(limit).map((r) => ({
        id: r.id,
        ts: r.ts,
        service: r.service,
        provider: r.provider,
        command: r.command,
        model: r.model,
        cwd: r.cwd,
        // prompt 本文は返さない (1 件最大 1MB × limit 500)。 長さだけ添える。
        promptChars: r.prompt_chars,
        status: r.status,
        exitCode: r.exit_code,
        durationMs: r.duration_ms,
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
        totalTokens: r.total_tokens,
        costUsd: r.cost_usd,
        metadata: parseJson(r.metadata_json),
      })),
      summary: deps.oneShots.summarySince(sinceMs).map((r) => ({
        service: r.service,
        provider: r.provider,
        calls: r.calls,
        okCalls: r.ok_calls,
        errorCalls: r.error_calls,
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
        totalTokens: r.total_tokens,
        costUsd: r.cost_usd,
        lastTs: r.last_ts,
      })),
    });
  });

  return app;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function parseStatus(v: unknown): CostOneShotStatus {
  return v === "ok" || v === "error" || v === "timeout" ? v : "unknown";
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function logTiming(route: string, started: number, extra: Record<string, unknown>): void {
  log.info({ route, ms: Date.now() - started, ...extra }, "cost api timing");
}

function emptyCostReport(): CostReport {
  return {
    codexTotals: { input: 0, cached: 0, output: 0, total: 0 },
    claudeTotals: { input: 0, cached: 0, output: 0, total: 0 },
    codexRate: { used5h: null, usedWeekly: null, reset5hAt: null, resetWeeklyAt: null, plan: null },
    claudeUsage: null,
  };
}
