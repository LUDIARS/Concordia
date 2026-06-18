/**
 * POST/GET /v1/cost-feed — ingest validation + aggregation round-trip。
 * (Anatomia/src/adapters/web/__tests__/cost-route.test.ts の移植)
 */
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { costFeedRouter } from "./cost-feed.js";
import { createMemoryCostFeed } from "../cost/cost-feed.js";
import type { CostFeedReport } from "../cost/cost-feed-aggregate.js";

async function getReport(app: Hono): Promise<CostFeedReport> {
  const res = await app.request("/v1/cost-feed");
  return (await res.json()) as CostFeedReport;
}

async function postResult(res: Response): Promise<{ ok: boolean; recorded?: number; error?: string }> {
  return (await res.json()) as { ok: boolean; recorded?: number; error?: string };
}

function appWithFeed() {
  const app = new Hono();
  app.route("/v1/cost-feed", costFeedRouter({ feed: createMemoryCostFeed() }));
  return app;
}

const post = (app: Hono, body: unknown) =>
  app.request("/v1/cost-feed", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("cost-feed route", () => {
  it("ingests rows and aggregates them on GET", async () => {
    const app = appWithFeed();
    const res = await post(app, {
      service: "discutere",
      ts: 100,
      sessions: [
        { sessionId: "S1", model: "opus", backend: "claude-cli", calls: 2, costUsd: 0.02, cacheReadTokens: 100 },
        { sessionId: "S2", model: "haiku", backend: "claude-cli", calls: 1, costUsd: 0.005 },
      ],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, recorded: 2 });

    const r = await getReport(app);
    expect(r.total.calls).toBe(3);
    expect(r.total.costUsd).toBeCloseTo(0.025, 9);
    expect(r.total.sessions).toBe(2);
    expect(r.byService.find((a) => a.key === "discutere")?.calls).toBe(3);
  });

  it("re-pushing the same session replaces (latest wins, no double count)", async () => {
    const app = appWithFeed();
    await post(app, { service: "discutere", ts: 1, sessions: [{ sessionId: "S1", model: "opus", backend: "cli", calls: 1, costUsd: 0.01 }] });
    await post(app, { service: "discutere", ts: 2, sessions: [{ sessionId: "S1", model: "opus", backend: "cli", calls: 4, costUsd: 0.04 }] });
    const r = await getReport(app);
    expect(r.total.calls).toBe(4); // 5 ではない
    expect(r.total.costUsd).toBeCloseTo(0.04, 9);
  });

  it("rejects missing service with 400", async () => {
    const app = appWithFeed();
    const res = await post(app, { sessions: [{ sessionId: "S1" }] });
    expect(res.status).toBe(400);
    expect((await postResult(res)).ok).toBe(false);
  });

  it("rejects invalid json with 400", async () => {
    const app = appWithFeed();
    const res = await app.request("/v1/cost-feed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("skips rows without sessionId, coerces non-numbers to 0", async () => {
    const app = appWithFeed();
    const res = await post(app, {
      service: "discutere",
      sessions: [
        { model: "opus" }, // sessionId なし → skip
        { sessionId: "S1", calls: "oops", costUsd: 0.01 }, // calls 非数値 → 0
      ],
    });
    expect((await postResult(res)).recorded).toBe(1);
    const r = await getReport(app);
    expect(r.total.calls).toBe(0);
    expect(r.total.costUsd).toBeCloseTo(0.01, 9);
  });
});
