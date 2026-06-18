/**
 * host_metrics (スナップショット時系列) の保存・読み出し・剪定。
 */

import type Database from "better-sqlite3";
import type { HostSnapshot } from "./collector.js";

export class MetricsStore {
  constructor(private readonly db: Database.Database) {}

  insert(snapshot: HostSnapshot): void {
    this.db
      .prepare(`INSERT INTO host_metrics(sampled_at, payload) VALUES (?, ?)`)
      .run(snapshot.sampled_at, JSON.stringify(snapshot));
  }

  /** 最新スナップショット (無ければ null)。 */
  latest(): HostSnapshot | null {
    const row = this.db
      .prepare(`SELECT payload FROM host_metrics ORDER BY sampled_at DESC LIMIT 1`)
      .get() as { payload: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.payload) as HostSnapshot;
    } catch {
      return null;
    }
  }

  /** 指定 session の RSS 時系列 (sparkline 用)。 [{t, rss}] 昇順。 */
  sessionSeries(sessionId: string, sinceMs: number): Array<{ t: number; rss: number }> {
    const rows = this.db
      .prepare(`SELECT sampled_at AS t, payload FROM host_metrics WHERE sampled_at >= ? ORDER BY sampled_at ASC`)
      .all(sinceMs) as Array<{ t: number; payload: string }>;
    const out: Array<{ t: number; rss: number }> = [];
    for (const r of rows) {
      try {
        const snap = JSON.parse(r.payload) as HostSnapshot;
        const s = snap.sessions.find((x) => x.session_id === sessionId);
        if (s) out.push({ t: r.t, rss: s.rss });
      } catch { /* skip */ }
    }
    return out;
  }

  /** retention より古い行を削除。 */
  prune(olderThanMs: number): number {
    const r = this.db.prepare(`DELETE FROM host_metrics WHERE sampled_at < ?`).run(olderThanMs);
    return r.changes ?? 0;
  }
}
