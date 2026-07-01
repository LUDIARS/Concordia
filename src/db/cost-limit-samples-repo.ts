/**
 * Provider usage-limit percentage samples.
 *
 * Rows are sampled periodically from provider rate-limit telemetry, not from
 * token totals. Percent fields are "used" percentages in the 0..100 range.
 */

import type Database from "better-sqlite3";

export interface CostLimitSampleInput {
  ts: number;
  provider: string;
  plan: string | null;
  used_5h_pct: number | null;
  used_weekly_pct: number | null;
  reset_5h_at: number | null;
  reset_weekly_at: number | null;
}

export interface CostLimitSampleRow extends CostLimitSampleInput {
  id: number;
}

export class CostLimitSamplesRepo {
  constructor(private readonly db: Database.Database) {}

  insert(s: CostLimitSampleInput): void {
    this.db
      .prepare(
        `INSERT INTO cost_limit_samples
           (ts, provider, plan, used_5h_pct, used_weekly_pct, reset_5h_at, reset_weekly_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        Math.floor(s.ts),
        s.provider,
        s.plan,
        pctOrNull(s.used_5h_pct),
        pctOrNull(s.used_weekly_pct),
        s.reset_5h_at === null ? null : Math.floor(s.reset_5h_at),
        s.reset_weekly_at === null ? null : Math.floor(s.reset_weekly_at),
      );
  }

  insertMany(samples: CostLimitSampleInput[]): void {
    if (samples.length === 0) return;
    const tx = this.db.transaction((rows: CostLimitSampleInput[]) => {
      for (const s of rows) this.insert(s);
    });
    tx(samples);
  }

  listSince(sinceSec: number): CostLimitSampleRow[] {
    return this.db
      .prepare(
        `SELECT id, ts, provider, plan, used_5h_pct, used_weekly_pct, reset_5h_at, reset_weekly_at
           FROM cost_limit_samples WHERE ts >= ? ORDER BY ts ASC`,
      )
      .all(Math.floor(sinceSec)) as CostLimitSampleRow[];
  }

  listLatestByProvider(): CostLimitSampleRow[] {
    return this.db
      .prepare(
        `SELECT id, ts, provider, plan, used_5h_pct, used_weekly_pct, reset_5h_at, reset_weekly_at
           FROM cost_limit_samples
          WHERE id IN (
            SELECT MAX(id) FROM cost_limit_samples GROUP BY provider
          )
          ORDER BY provider ASC`,
      )
      .all() as CostLimitSampleRow[];
  }

  pruneOlderThan(cutoffSec: number): number {
    const r = this.db
      .prepare(`DELETE FROM cost_limit_samples WHERE ts < ?`)
      .run(Math.floor(cutoffSec));
    return r.changes;
  }
}

function pctOrNull(v: number | null): number | null {
  if (v === null || !Number.isFinite(v)) return null;
  return Math.max(0, Math.min(100, v));
}
