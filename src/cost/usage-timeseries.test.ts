import { describe, it, expect } from "vitest";
import { aggregateUsageTimeseries } from "./usage-timeseries.js";
import type { CostUsageSampleRow } from "../db/cost-usage-samples-repo.js";

function row(id: number, ts: number, session: string, ctx: number | null, cost: number): CostUsageSampleRow {
  return { id, ts, session_id: session, subsidiary_id: null, provider: "claude-code", context_tokens: ctx, cost_tokens: cost };
}

describe("aggregateUsageTimeseries", () => {
  it("時刻バケットに畳み、 cost は前サンプル差分 (初回 baseline=0) を spent に積む", () => {
    // bucket=100s。 セッション s1: ts100 cost=1000(baseline), ts150 cost=1500(+500), ts250 cost=1800(+300)
    const r = aggregateUsageTimeseries(
      [
        row(1, 100, "s1", 50000, 1000),
        row(2, 150, "s1", 60000, 1500),
        row(3, 250, "s1", 40000, 1800),
      ],
      100,
    );
    expect(r.bucketSec).toBe(100);
    // bucket 100: 2 サンプル (ts100,150) → spent = 0(baseline) + 500 = 500、 context = 50000+60000
    // bucket 200: 1 サンプル (ts250) → spent = 300、 context = 40000
    expect(r.points).toEqual([
      { ts: 100, sessions: 1, contextTokens: 110000, spentTokens: 500 },
      { ts: 200, sessions: 1, contextTokens: 40000, spentTokens: 300 },
    ]);
  });

  it("複数セッションを同バケットで合算し distinct 数を数える", () => {
    const r = aggregateUsageTimeseries(
      [
        row(1, 10, "a", 100, 10),
        row(2, 20, "a", 100, 30), // +20
        row(3, 15, "b", 200, 5),
      ],
      100,
    );
    expect(r.points).toHaveLength(1);
    expect(r.points[0]).toEqual({ ts: 0, sessions: 2, contextTokens: 400, spentTokens: 20 });
  });

  it("cost のリセット (負 delta) は 0 に切る", () => {
    const r = aggregateUsageTimeseries(
      [row(1, 10, "a", null, 1000), row(2, 20, "a", null, 200)],
      100,
    );
    expect(r.points[0].spentTokens).toBe(0); // baseline=0, 2点目は -800 → 0
  });

  it("context_tokens null は 0 扱いで合算 (負にしない)", () => {
    const r = aggregateUsageTimeseries([row(1, 10, "a", null, 5)], 100);
    expect(r.points[0].contextTokens).toBe(0);
  });

  it("入力が順不同でも session 内を時刻順に並べてから delta を取る", () => {
    const r = aggregateUsageTimeseries(
      [row(2, 250, "s1", 0, 1800), row(1, 100, "s1", 0, 1000), row(3, 150, "s1", 0, 1500)],
      1000,
    );
    // 1 バケット(0): baseline1000 → +500 → +300 = spent 800
    expect(r.points[0].spentTokens).toBe(800);
  });
});
