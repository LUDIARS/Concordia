/**
 * src/cost/cost-feed-aggregate.ts — cost-feed entry をパネル用に集計する。
 *
 * Anatomia/src/cost/aggregate.ts の移植。サービスは per-(session × model ×
 * backend) 要約を push し、議論の進行に応じて同じ session を再 push しうる。
 * よって (service, sessionId, model, backend) ごとに LATEST 行へ DEDUPE して
 * から合算する — 累積要約の再 push は「置換」であって二重計上しない。
 *
 * SRP: CostFeedEntry[] に対する純粋な集計。I/O なし。
 */

import type { CostFeedEntry } from "./cost-feed.js";

export interface CostAgg {
  /** group key: "(total)" / サービス名 / model id。 */
  key: string;
  /** この group に畳み込まれた distinct (service, sessionId) 数。 */
  sessions: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

export interface CostFeedReport {
  total: CostAgg;
  byService: CostAgg[];
  byModel: CostAgg[];
  /** 見えた最新 entry の ts (epoch ms)、空なら null。 */
  updatedAt: number | null;
}

const SEP = " ";

/** (service, sessionId, model, backend) ごとに latest entry を残す。 */
function dedupeLatest(entries: CostFeedEntry[]): CostFeedEntry[] {
  const map = new Map<string, CostFeedEntry>();
  for (const e of entries) {
    const k = [e.service, e.sessionId, e.model ?? "", e.backend ?? ""].join(SEP);
    const prev = map.get(k);
    if (!prev || e.ts >= prev.ts) map.set(k, e);
  }
  return [...map.values()];
}

function blank(key: string): CostAgg {
  return {
    key,
    sessions: 0,
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
  };
}

function add(agg: CostAgg, e: CostFeedEntry, sessions: Set<string>): void {
  agg.calls += e.calls;
  agg.inputTokens += e.inputTokens;
  agg.outputTokens += e.outputTokens;
  agg.cacheReadTokens += e.cacheReadTokens;
  agg.cacheCreationTokens += e.cacheCreationTokens;
  agg.costUsd += e.costUsd;
  sessions.add(e.service + SEP + e.sessionId);
}

export function aggregateCostFeed(entries: CostFeedEntry[]): CostFeedReport {
  const rows = dedupeLatest(entries);
  const updatedAt = entries.length ? Math.max(...entries.map((e) => e.ts)) : null;

  const total = blank("(total)");
  const totalSessions = new Set<string>();
  for (const e of rows) add(total, e, totalSessions);
  total.sessions = totalSessions.size;

  const group = (keyOf: (e: CostFeedEntry) => string): CostAgg[] => {
    const map = new Map<string, { agg: CostAgg; sessions: Set<string> }>();
    for (const e of rows) {
      const k = keyOf(e);
      let g = map.get(k);
      if (!g) {
        g = { agg: blank(k), sessions: new Set() };
        map.set(k, g);
      }
      add(g.agg, e, g.sessions);
    }
    return [...map.values()]
      .map(({ agg, sessions }) => {
        agg.sessions = sessions.size;
        return agg;
      })
      .sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls);
  };

  return {
    total,
    byService: group((e) => e.service),
    byModel: group((e) => e.model ?? "(unknown)"),
    updatedAt,
  };
}
