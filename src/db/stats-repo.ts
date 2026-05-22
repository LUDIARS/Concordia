/**
 * session_stats DB access layer.
 *
 * - active session が 10 分毎に POST する現況スナップショット (JSON) を蓄積
 * - 他 session (フラットなエージェントチーム) からも GET 可能
 * - latest 取得 / 履歴取得 / 全 session の最新を一括取得
 */

import type Database from "better-sqlite3";

export interface SessionStatRow {
  id: number;
  session_id: string;
  ts: number;
  payload: string; // JSON 文字列
}

export interface LatestStatPerSession {
  session_id: string;
  latest_ts: number;
  payload: string;
}

export class StatsRepo {
  constructor(private readonly db: Database.Database) {}

  /** stat を 1 件追加. payload は object でも文字列でもよい. */
  insert(input: { session_id: string; ts?: number; payload: object | string }): SessionStatRow {
    const ts = input.ts ?? Math.floor(Date.now() / 1000);
    const payloadStr = typeof input.payload === "string" ? input.payload : JSON.stringify(input.payload);
    const r = this.db
      .prepare(`INSERT INTO session_stats(session_id, ts, payload) VALUES (?, ?, ?)`)
      .run(input.session_id, ts, payloadStr);
    return this.findById(Number(r.lastInsertRowid))!;
  }

  findById(id: number): SessionStatRow | null {
    return (
      (this.db.prepare(`SELECT * FROM session_stats WHERE id = ?`).get(id) as SessionStatRow | undefined) ??
      null
    );
  }

  /** 指定 session の最新 1 件. */
  latest(sessionId: string): SessionStatRow | null {
    return (
      (this.db
        .prepare(`SELECT * FROM session_stats WHERE session_id = ? ORDER BY ts DESC LIMIT 1`)
        .get(sessionId) as SessionStatRow | undefined) ?? null
    );
  }

  /** 指定 session の履歴 (新しい順). */
  history(sessionId: string, limit = 50): SessionStatRow[] {
    return this.db
      .prepare(`SELECT * FROM session_stats WHERE session_id = ? ORDER BY ts DESC LIMIT ?`)
      .all(sessionId, limit) as SessionStatRow[];
  }

  /**
   * 全 session の最新 stat を 1 件ずつ返す (フラットチーム閲覧用).
   * Concordia の他 session が「今みんな何やってる?」 を取るときの入口.
   */
  latestPerSession(): LatestStatPerSession[] {
    return this.db
      .prepare(
        `SELECT s.session_id, s.ts AS latest_ts, s.payload
         FROM session_stats s
         JOIN (
           SELECT session_id, MAX(ts) AS max_ts
           FROM session_stats
           GROUP BY session_id
         ) m ON m.session_id = s.session_id AND m.max_ts = s.ts
         ORDER BY s.ts DESC`,
      )
      .all() as LatestStatPerSession[];
  }

  /**
   * 指定 session の「最後に stat が記録された ts」 を返す (秒、 無ければ null).
   * スケジューラの 10 分間隔判定用.
   */
  lastTs(sessionId: string): number | null {
    const row = this.db
      .prepare(`SELECT MAX(ts) AS ts FROM session_stats WHERE session_id = ?`)
      .get(sessionId) as { ts: number | null } | undefined;
    return row?.ts ?? null;
  }

  /** ts より古い stat を全削除し、 削除件数を返す (将来の retention 用). */
  purgeOlderThan(cutoffTs: number): number {
    const r = this.db.prepare(`DELETE FROM session_stats WHERE ts < ?`).run(cutoffTs);
    return Number(r.changes ?? 0);
  }
}
