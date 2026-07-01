/**
 * cost_usage_samples (10 分毎・セッション別) を時刻バケットに畳んで WebUI グラフ用の
 * 系列に変換する純関数。
 *
 * 各バケットで:
 *   - sessions       : そのバケットに現れた distinct セッション数
 *   - contextTokens  : コンテキスト占有の合計 (スナップショット。 現在どれだけ重いか)
 *   - spentTokens    : 「そのバケットで使ったトークン」 = 各セッションの cost_tokens の
 *                      前サンプルからの増分 (delta) の合計。 cost_tokens は累積なので、
 *                      delta を取ることで「いつ使ったか」 が見える。 各セッションの初回
 *                      サンプルは baseline 扱いで delta=0 (起動時の既存累積を 1 点に
 *                      誤計上しない)。
 */

import type { CostUsageSampleRow } from "../db/cost-usage-samples-repo.js";

export interface UsageTimeseriesPoint {
  /** バケット開始の epoch 秒。 */
  ts: number;
  /** バケット内の distinct セッション数。 */
  sessions: number;
  /** コンテキスト占有トークンの合計 (スナップショット)。 */
  contextTokens: number;
  /** そのバケットで消費したトークン (累積の前サンプル差分の合計)。 */
  spentTokens: number;
}

export interface UsageProviderTimeseriesPoint extends UsageTimeseriesPoint {
  provider: string;
}

export interface UsageTimeseries {
  bucketSec: number;
  points: UsageTimeseriesPoint[];
  providers: Record<string, UsageTimeseriesPoint[]>;
  providerPoints: UsageProviderTimeseriesPoint[];
}

function bucketOf(tsSec: number, bucketSec: number): number {
  return Math.floor(tsSec / bucketSec) * bucketSec;
}

/**
 * samples (時刻昇順でなくてよい) を bucketSec ごとに畳む。
 * spentTokens は per-session の cost_tokens delta を時刻順に積む (初回は baseline=0)。
 */
export function aggregateUsageTimeseries(
  samples: CostUsageSampleRow[],
  bucketSec: number,
): UsageTimeseries {
  const bsec = bucketSec > 0 ? Math.floor(bucketSec) : 600;

  // per-session に時刻昇順で並べ、 隣接サンプルの cost delta を出す。
  const bySession = new Map<string, CostUsageSampleRow[]>();
  for (const s of samples) {
    const arr = bySession.get(s.session_id);
    if (arr) arr.push(s);
    else bySession.set(s.session_id, [s]);
  }

  // bucket → 集計
  const buckets = new Map<
    number,
    { sessions: Set<string>; context: number; spent: number }
  >();
  const ensure = (b: number) => {
    let e = buckets.get(b);
    if (!e) {
      e = { sessions: new Set<string>(), context: 0, spent: 0 };
      buckets.set(b, e);
    }
    return e;
  };

  for (const [sid, rows] of bySession) {
    rows.sort((a, b) => a.ts - b.ts);
    let prevCost: number | null = null;
    for (const r of rows) {
      const b = bucketOf(r.ts, bsec);
      const e = ensure(b);
      e.sessions.add(sid);
      e.context += Math.max(0, r.context_tokens ?? 0);
      // 初回 (prevCost=null) は baseline → spent 0。 以降は増分のみ (負値=リセットは 0 に切る)。
      if (prevCost !== null) {
        const delta = r.cost_tokens - prevCost;
        if (delta > 0) e.spent += delta;
      }
      prevCost = r.cost_tokens;
    }
  }

  const points = materializeBuckets(buckets);
  const providers = aggregateProviderUsageTimeseries(samples, bsec);
  const providerPoints = Object.entries(providers).flatMap(([provider, rows]) =>
    rows.map((p) => ({ ...p, provider })),
  );

  return { bucketSec: bsec, points, providers, providerPoints };
}

function aggregateProviderUsageTimeseries(
  samples: CostUsageSampleRow[],
  bucketSec: number,
): Record<string, UsageTimeseriesPoint[]> {
  const grouped = new Map<string, CostUsageSampleRow[]>();
  for (const s of samples) {
    const provider = (s.provider ?? "unknown").trim() || "unknown";
    const rows = grouped.get(provider);
    if (rows) rows.push(s);
    else grouped.set(provider, [s]);
  }

  const out: Record<string, UsageTimeseriesPoint[]> = {};
  for (const [provider, rows] of [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    out[provider] = aggregateUsageTimeseriesForRows(rows, bucketSec);
  }
  return out;
}

function aggregateUsageTimeseriesForRows(
  samples: CostUsageSampleRow[],
  bucketSec: number,
): UsageTimeseriesPoint[] {
  const bySession = new Map<string, CostUsageSampleRow[]>();
  for (const s of samples) {
    const arr = bySession.get(s.session_id);
    if (arr) arr.push(s);
    else bySession.set(s.session_id, [s]);
  }

  const buckets = new Map<
    number,
    { sessions: Set<string>; context: number; spent: number }
  >();
  const ensure = (b: number) => {
    let e = buckets.get(b);
    if (!e) {
      e = { sessions: new Set<string>(), context: 0, spent: 0 };
      buckets.set(b, e);
    }
    return e;
  };

  for (const [sid, rows] of bySession) {
    rows.sort((a, b) => a.ts - b.ts);
    let prevCost: number | null = null;
    for (const r of rows) {
      const b = bucketOf(r.ts, bucketSec);
      const e = ensure(b);
      e.sessions.add(sid);
      e.context += Math.max(0, r.context_tokens ?? 0);
      if (prevCost !== null) {
        const delta = r.cost_tokens - prevCost;
        if (delta > 0) e.spent += delta;
      }
      prevCost = r.cost_tokens;
    }
  }

  return materializeBuckets(buckets);
}

function materializeBuckets(
  buckets: Map<number, { sessions: Set<string>; context: number; spent: number }>,
): UsageTimeseriesPoint[] {
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ts, e]) => ({
      ts,
      sessions: e.sessions.size,
      contextTokens: e.context,
      spentTokens: e.spent,
    }));
}
