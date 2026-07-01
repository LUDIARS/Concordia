/**
 * cost_usage_samples の永続層 — 10 分毎のセッション別使用量サンプル (時系列)。
 *
 * 各行 = ある時刻における 1 セッションの「現在のコンテキスト占有」 と「累積消費トークン」。
 * WebUI の /cost が時刻範囲で読み出し、 折れ線グラフ化する。 集計 (バケット化 / 系列分け) は
 * 読み出し側 (api/cost.ts) で行い、 ここは insert と範囲取得だけを持つ (SRP)。
 */

import type Database from "better-sqlite3";

export interface CostUsageSampleInput {
  ts: number;
  session_id: string;
  subsidiary_id: string | null;
  provider: string | null;
  context_tokens: number | null;
  cost_tokens: number;
}

export interface CostUsageSampleRow extends CostUsageSampleInput {
  id: number;
}

export class CostUsageSamplesRepo {
  constructor(private readonly db: Database.Database) {}

  /** 1 サンプルを記録する。 */
  insert(s: CostUsageSampleInput): void {
    this.db
      .prepare(
        `INSERT INTO cost_usage_samples
           (ts, session_id, subsidiary_id, provider, context_tokens, cost_tokens)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        Math.floor(s.ts),
        s.session_id,
        s.subsidiary_id,
        s.provider,
        s.context_tokens === null ? null : Math.floor(s.context_tokens),
        Math.floor(s.cost_tokens),
      );
  }

  /** 複数サンプルを 1 トランザクションで記録する (10 分サンプラの 1 周期分)。 */
  insertMany(samples: CostUsageSampleInput[]): void {
    if (samples.length === 0) return;
    const tx = this.db.transaction((rows: CostUsageSampleInput[]) => {
      for (const s of rows) this.insert(s);
    });
    tx(samples);
  }

  /** [sinceSec, nowSec] 範囲のサンプルを時刻昇順で返す。 */
  listSince(sinceSec: number): CostUsageSampleRow[] {
    return this.db
      .prepare(
        `SELECT id, ts, session_id, subsidiary_id, provider, context_tokens, cost_tokens
           FROM cost_usage_samples WHERE ts >= ? ORDER BY ts ASC`,
      )
      .all(Math.floor(sinceSec)) as CostUsageSampleRow[];
  }

  /** retentionSec より古いサンプルを掃除する (長期肥大の抑制)。 */
  pruneOlderThan(cutoffSec: number): number {
    const r = this.db
      .prepare(`DELETE FROM cost_usage_samples WHERE ts < ?`)
      .run(Math.floor(cutoffSec));
    return r.changes;
  }
}
