/**
 * チームカード用メトリクスの read model (spec/feature/teams.md §4.1)。
 *
 * 既存正本 (director_cases / director_steps / sessions / cost_usage_samples) を
 * SQL で束ねるだけで、 新しい集計テーブルは作らない。 コストは 10 分毎サンプルの
 * 累積 cost_tokens の正の差分をセッション毎に畳み、 team へ合算する。
 */

import type Database from "better-sqlite3";

export interface TeamMetrics {
  /** director_cases (目標) の総数。 */
  goal_count: number;
  /** 未完了 step (pending/active/blocked) を持つ case 数。 */
  active_case_count: number;
  /** status='active' のセッション数。 */
  active_session_count: number;
  /** 当日 (local 00:00〜) の消費トークン。 */
  today_cost_tokens: number;
}

export interface TeamCostPoint {
  ts: number;
  cost_tokens: number;
}

interface TeamSampleRow {
  session_id: string;
  ts: number;
  cost_tokens: number;
}

interface TeamDailySampleRow extends TeamSampleRow {
  team_id: string;
}

interface StoredTeamSampleRow extends TeamSampleRow {
  sample_id: number;
}

const EMPTY: TeamMetrics = {
  goal_count: 0,
  active_case_count: 0,
  active_session_count: 0,
  today_cost_tokens: 0,
};

/** epoch(ms) → その local 暦日 00:00 の epoch 秒 (org-cost.ts と同じ窓定義)。 */
export function localMidnightSec(nowMs: number): number {
  const d = new Date(nowMs);
  return Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000);
}

/**
 * セッション毎の累積 cost_tokens サンプル列を、 bucketSec 幅の「消費」系列へ畳む。
 * 各サンプルは直前サンプルとの差分 (負は 0 扱い = セッション再開時の巻き戻り対策) を
 * そのサンプル時刻のバケットへ計上する。
 */
export function bucketTeamCostSeries(
  samples: readonly TeamSampleRow[],
  bucketSec: number,
): TeamCostPoint[] {
  const lastBySession = new Map<string, number>();
  const byBucket = new Map<number, number>();
  for (const sample of samples) {
    const prev = lastBySession.get(sample.session_id);
    lastBySession.set(sample.session_id, sample.cost_tokens);
    if (prev === undefined) continue;
    const delta = Math.max(0, sample.cost_tokens - prev);
    if (delta === 0) continue;
    const bucket = Math.floor(sample.ts / bucketSec) * bucketSec;
    byBucket.set(bucket, (byBucket.get(bucket) ?? 0) + delta);
  }
  return [...byBucket.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ts, cost_tokens]) => ({ ts, cost_tokens }));
}

function sumTeamCostByTeam(samples: readonly TeamDailySampleRow[]): Map<string, number> {
  const lastBySession = new Map<string, number>();
  const totalByTeam = new Map<string, number>();
  for (const sample of samples) {
    const previous = lastBySession.get(sample.session_id);
    lastBySession.set(sample.session_id, sample.cost_tokens);
    if (previous === undefined) continue;
    const delta = Math.max(0, sample.cost_tokens - previous);
    totalByTeam.set(sample.team_id, (totalByTeam.get(sample.team_id) ?? 0) + delta);
  }
  return totalByTeam;
}

export class TeamMetricsRepo {
  constructor(private readonly db: Database.Database) {}

  /** 全チーム分のメトリクスを 1 度に返す (GET /v1/teams のカード用)。 */
  collect(nowMs: number = Date.now()): Map<string, TeamMetrics> {
    const metrics = new Map<string, TeamMetrics>();
    const entry = (teamId: string): TeamMetrics => {
      const found = metrics.get(teamId);
      if (found) return found;
      const created = { ...EMPTY };
      metrics.set(teamId, created);
      return created;
    };

    const goals = this.db.prepare(`
      SELECT team_id, COUNT(*) AS n FROM director_cases WHERE team_id IS NOT NULL GROUP BY team_id
    `).all() as Array<{ team_id: string; n: number }>;
    for (const row of goals) entry(row.team_id).goal_count = row.n;

    const activeCases = this.db.prepare(`
      SELECT c.team_id AS team_id, COUNT(DISTINCT c.id) AS n
        FROM director_cases c
        JOIN director_steps s ON s.case_id = c.id
       WHERE c.team_id IS NOT NULL AND s.status IN ('pending', 'active', 'blocked')
       GROUP BY c.team_id
    `).all() as Array<{ team_id: string; n: number }>;
    for (const row of activeCases) entry(row.team_id).active_case_count = row.n;

    const activeSessions = this.db.prepare(`
      SELECT team_id, COUNT(*) AS n FROM sessions
       WHERE team_id IS NOT NULL AND status = 'active' GROUP BY team_id
    `).all() as Array<{ team_id: string; n: number }>;
    for (const row of activeSessions) entry(row.team_id).active_session_count = row.n;

    const todaySamples = this.db.prepare(`
      SELECT s.team_id AS team_id, c.session_id AS session_id, c.ts AS ts,
             c.cost_tokens AS cost_tokens
        FROM cost_usage_samples c
        JOIN sessions s ON s.id = c.session_id
       WHERE s.team_id IS NOT NULL AND c.ts >= ? AND c.ts <= ?
       ORDER BY c.session_id, c.ts ASC, c.id ASC
    `).all(localMidnightSec(nowMs), Math.floor(nowMs / 1000)) as TeamDailySampleRow[];
    for (const [teamId, tokens] of sumTeamCostByTeam(todaySamples)) {
      entry(teamId).today_cost_tokens = tokens;
    }

    return metrics;
  }

  /** 1 チームのコスト時系列 (チーム詳細タブのグラフ用)。 */
  costSeries(teamId: string, sinceSec: number, bucketSec: number): TeamCostPoint[] {
    const since = Math.floor(sinceSec);
    const samples = this.db.prepare(`
      SELECT c.id AS sample_id, c.session_id AS session_id, c.ts AS ts,
             c.cost_tokens AS cost_tokens
        FROM cost_usage_samples c
        JOIN sessions s ON s.id = c.session_id
       WHERE s.team_id = ? AND c.ts >= ?
      UNION ALL
      SELECT c.id AS sample_id, c.session_id AS session_id, c.ts AS ts,
             c.cost_tokens AS cost_tokens
        FROM sessions s
        JOIN cost_usage_samples c ON c.id = (
          SELECT previous.id
            FROM cost_usage_samples previous
           WHERE previous.session_id = s.id AND previous.ts < ?
           ORDER BY previous.ts DESC, previous.id DESC
           LIMIT 1
        )
       WHERE s.team_id = ?
       ORDER BY session_id, ts ASC, sample_id ASC
    `).all(teamId, since, since, teamId) as StoredTeamSampleRow[];
    return bucketTeamCostSeries(samples, bucketSec);
  }
}
