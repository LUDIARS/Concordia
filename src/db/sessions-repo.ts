/**
 * sessions / session_events / session_reports の DB アクセス層.
 */

import type Database from "better-sqlite3";
import type {
  ProviderName,
  SessionEventRow,
  SessionReportRow,
  SessionRow,
  SessionStatus,
} from "../shared/types.js";

export class SessionsRepo {
  constructor(private readonly db: Database.Database) {}

  // ─── sessions ───────────────────────────────────────

  insertSession(input: {
    id: string;
    provider: ProviderName;
    repo_path: string;
    repo_origin: string | null;
    branch: string | null;
    host: string;
    started_at: number;
    last_seen_at: number;
    transcript_path: string | null;
    metadata: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO sessions(
          id, provider, repo_path, repo_origin, branch, host,
          started_at, ended_at, status, last_seen_at, current_task,
          transcript_path, metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'active', ?, NULL, ?, ?)`,
      )
      .run(
        input.id,
        input.provider,
        input.repo_path,
        input.repo_origin,
        input.branch,
        input.host,
        input.started_at,
        input.last_seen_at,
        input.transcript_path,
        input.metadata,
      );
  }

  findSession(id: string): SessionRow | null {
    return (
      (this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as SessionRow | undefined) ??
      null
    );
  }

  /** 同 repo_origin の active session 一覧 (引数 id を除外) */
  findActivePeers(repoOrigin: string | null, excludeId: string): SessionRow[] {
    if (!repoOrigin) return [];
    return this.db
      .prepare(
        `SELECT * FROM sessions WHERE repo_origin = ? AND status = 'active' AND id != ?
         ORDER BY started_at DESC`,
      )
      .all(repoOrigin, excludeId) as SessionRow[];
  }

  /** 同 (repo_origin, host) の lost session 一覧 (resume 候補) */
  findLostCandidates(repoOrigin: string | null, host: string): SessionRow[] {
    if (!repoOrigin) return [];
    return this.db
      .prepare(
        `SELECT * FROM sessions WHERE repo_origin = ? AND host = ? AND status = 'lost'
         ORDER BY last_seen_at DESC`,
      )
      .all(repoOrigin, host) as SessionRow[];
  }

  listSessions(filter: {
    repo_origin?: string;
    host?: string;
    status?: SessionStatus;
    provider?: ProviderName;
  }): SessionRow[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.repo_origin) { where.push("repo_origin = ?"); args.push(filter.repo_origin); }
    if (filter.host)        { where.push("host = ?");        args.push(filter.host); }
    if (filter.status)      { where.push("status = ?");      args.push(filter.status); }
    if (filter.provider)    { where.push("provider = ?");    args.push(filter.provider); }
    const sql =
      `SELECT * FROM sessions ${where.length ? "WHERE " + where.join(" AND ") : ""} ` +
      `ORDER BY started_at DESC LIMIT 200`;
    return this.db.prepare(sql).all(...args) as SessionRow[];
  }

  updateHeartbeat(id: string, ts: number): void {
    this.db.prepare(`UPDATE sessions SET last_seen_at = ? WHERE id = ?`).run(ts, id);
  }

  patchSession(id: string, patch: { current_task?: string; branch?: string }): void {
    const sets: string[] = [];
    const args: unknown[] = [];
    if (patch.current_task !== undefined) { sets.push("current_task = ?"); args.push(patch.current_task); }
    if (patch.branch !== undefined)       { sets.push("branch = ?");       args.push(patch.branch); }
    if (sets.length === 0) return;
    args.push(id);
    this.db.prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`).run(...args);
  }

  setMetadata(id: string, metadata: string | null): void {
    this.db.prepare(`UPDATE sessions SET metadata = ? WHERE id = ?`).run(metadata, id);
  }

  countEvents(sessionId: string): number {
    const r = this.db
      .prepare(`SELECT COUNT(*) AS n FROM session_events WHERE session_id = ?`)
      .get(sessionId) as { n: number };
    return r.n;
  }

  setStatus(id: string, status: SessionStatus, ts: number, endedAt?: number): void {
    this.db
      .prepare(
        `UPDATE sessions SET status = ?, last_seen_at = ?, ended_at = COALESCE(?, ended_at) WHERE id = ?`,
      )
      .run(status, ts, endedAt ?? null, id);
  }

  /** active で last_seen_at が cutoff より古いものを返す */
  findStaleActive(cutoff: number): SessionRow[] {
    return this.db
      .prepare(
        `SELECT * FROM sessions WHERE status = 'active' AND last_seen_at < ?`,
      )
      .all(cutoff) as SessionRow[];
  }

  /** lost で last_seen_at が cutoff より古いものを abandoned 化 */
  abandonLost(cutoff: number): number {
    const r = this.db
      .prepare(
        `UPDATE sessions SET status = 'abandoned' WHERE status = 'lost' AND last_seen_at < ?`,
      )
      .run(cutoff);
    return Number(r.changes ?? 0);
  }

  // ─── session_events ─────────────────────────────────

  appendEvent(input: { session_id: string; ts: number; kind: string; payload: object }): void {
    this.db
      .prepare(
        `INSERT INTO session_events(session_id, ts, kind, payload) VALUES (?, ?, ?, ?)`,
      )
      .run(input.session_id, input.ts, input.kind, JSON.stringify(input.payload));
  }

  recentEvents(sessionId: string, limit = 100): SessionEventRow[] {
    return this.db
      .prepare(
        `SELECT * FROM session_events WHERE session_id = ? ORDER BY ts DESC LIMIT ?`,
      )
      .all(sessionId, limit) as SessionEventRow[];
  }

  allEvents(sessionId: string): SessionEventRow[] {
    return this.db
      .prepare(`SELECT * FROM session_events WHERE session_id = ? ORDER BY ts ASC`)
      .all(sessionId) as SessionEventRow[];
  }

  purgeEventsOlderThan(cutoff: number): number {
    const r = this.db
      .prepare(`DELETE FROM session_events WHERE ts < ?`)
      .run(cutoff);
    return Number(r.changes ?? 0);
  }

  // ─── session_reports ────────────────────────────────

  upsertReport(row: SessionReportRow): void {
    this.db
      .prepare(
        `INSERT INTO session_reports(session_id, generated_at, summary_md, bullets, duration_sec, metadata)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           generated_at = excluded.generated_at,
           summary_md   = excluded.summary_md,
           bullets      = excluded.bullets,
           duration_sec = excluded.duration_sec,
           metadata     = excluded.metadata`,
      )
      .run(
        row.session_id,
        row.generated_at,
        row.summary_md,
        row.bullets,
        row.duration_sec,
        row.metadata,
      );
  }

  findReport(sessionId: string): SessionReportRow | null {
    return (
      (this.db
        .prepare(`SELECT * FROM session_reports WHERE session_id = ?`)
        .get(sessionId) as SessionReportRow | undefined) ?? null
    );
  }
}
