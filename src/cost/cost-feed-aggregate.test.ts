/**
 * aggregateCostFeed — key ごとの dedupe-latest / grouping / totals。
 * (Anatomia/src/cost/__tests__/aggregate.test.ts の移植)
 */
import { describe, it, expect } from "vitest";
import { aggregateCostFeed } from "./cost-feed-aggregate.js";
import type { CostFeedEntry } from "./cost-feed.js";

function entry(p: Partial<CostFeedEntry>): CostFeedEntry {
  return {
    ts: 1,
    service: "discutere",
    sessionId: "S1",
    calls: 1,
    inputTokens: 10,
    outputTokens: 4,
    cacheReadTokens: 100,
    cacheCreationTokens: 20,
    costUsd: 0.01,
    ...p,
  };
}

describe("aggregateCostFeed", () => {
  it("returns empty totals for no entries", () => {
    const r = aggregateCostFeed([]);
    expect(r.total.calls).toBe(0);
    expect(r.total.costUsd).toBe(0);
    expect(r.updatedAt).toBeNull();
    expect(r.byService).toEqual([]);
  });

  it("keeps the latest row per (service, session, model, backend)", () => {
    const rows = [
      entry({ ts: 1, model: "m", backend: "claude-cli", calls: 1, costUsd: 0.01 }),
      entry({ ts: 2, model: "m", backend: "claude-cli", calls: 3, costUsd: 0.05 }),
    ];
    const r = aggregateCostFeed(rows);
    expect(r.total.calls).toBe(3); // 1+3=4 ではない
    expect(r.total.costUsd).toBeCloseTo(0.05, 9);
    expect(r.total.sessions).toBe(1);
    expect(r.updatedAt).toBe(2);
  });

  it("sums across distinct keys and groups by service/model", () => {
    const rows = [
      entry({ service: "discutere", sessionId: "S1", model: "opus", costUsd: 0.02, calls: 2 }),
      entry({ service: "discutere", sessionId: "S2", model: "haiku", costUsd: 0.005, calls: 1 }),
      entry({ service: "anatomia", sessionId: "A1", model: "opus", costUsd: 0.03, calls: 1 }),
    ];
    const r = aggregateCostFeed(rows);
    expect(r.total.calls).toBe(4);
    expect(r.total.costUsd).toBeCloseTo(0.055, 9);
    expect(r.total.sessions).toBe(3);

    const disc = r.byService.find((a) => a.key === "discutere")!;
    expect(disc.sessions).toBe(2);
    expect(disc.costUsd).toBeCloseTo(0.025, 9);

    const opus = r.byModel.find((a) => a.key === "opus")!;
    expect(opus.calls).toBe(3); // S1(2) + A1(1)
    expect(opus.sessions).toBe(2); // (discutere,S1) + (anatomia,A1)

    // costUsd desc でソート
    expect(r.byService[0].costUsd).toBeGreaterThanOrEqual(r.byService[1].costUsd);
  });

  it("buckets missing model as (unknown)", () => {
    const r = aggregateCostFeed([entry({ model: undefined })]);
    expect(r.byModel[0].key).toBe("(unknown)");
  });
});
