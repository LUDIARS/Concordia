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

  /** 同 repo_path (作業ディレクトリ) の active session 一覧 (引数 id を除外) */
  findActivePeers(repoPath: string, excludeId: string): SessionRow[] {
    return this.db
      .prepare(
        `SELECT * FROM sessions WHERE repo_path = ? AND status = 'active' AND id != ?
         ORDER BY started_at DESC`,
      )
      .all(repoPath, excludeId) as SessionRow[];
  }

  /** すべての active session 一覧 (停止 nudge 等の周期スキャン用) */
  findAllActive(): SessionRow[] {
    return this.db
      .prepare(`SELECT * FROM sessions WHERE status = 'active' ORDER BY started_at DESC`)
      .all() as SessionRow[];
  }

  /** 同 (repo_path, host) の lost session 一覧 (resume 候補) */
  findLostCandidates(repoPath: string, host: string): SessionRow[] {
    return this.db
      .prepare(
        `SELECT * FROM sessions WHERE repo_path = ? AND host = ? AND status = 'lost'
         ORDER BY last_seen_at DESC`,
      )
      .all(repoPath, host) as SessionRow[];
  }

  listSessions(filter: {
    repo_origin?: string;
    host?: string;
    status?: SessionStatus;
    provider?: ProviderName;
    subsidiary_id?: string;
  }): SessionRow[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.repo_origin) { where.push("repo_origin = ?"); args.push(filter.repo_origin); }
    if (filter.host)        { where.push("host = ?");        args.push(filter.host); }
    if (filter.status)      { where.push("status = ?");      args.push(filter.status); }
    if (filter.provider)    { where.push("provider = ?");    args.push(filter.provider); }
    if (filter.subsidiary_id) {
      where.push("json_extract(metadata, '$.subsidiary_id') = ?");
      args.push(filter.subsidiary_id);
    }
    const sql =
      `SELECT * FROM sessions ${where.length ? "WHERE " + where.join(" AND ") : ""} ` +
      `ORDER BY started_at DESC LIMIT 200`;
    return this.db.prepare(sql).all(...args) as SessionRow[];
  }

  updateHeartbeat(id: string, ts: number): void {
    this.db.prepare(`UPDATE sessions SET last_seen_at = ? WHERE id = ?`).run(ts, id);
  }

  patchSession(
    id: string,
    patch: {
      current_task?: string;
      branch?: string;
      repo_path?: string;
      repo_origin?: string | null;
    },
  ): void {
    const sets: string[] = [];
    const args: unknown[] = [];
    if (patch.current_task !== undefined) { sets.push("current_task = ?"); args.push(patch.current_task); }
    if (patch.branch !== undefined)       { sets.push("branch = ?");       args.push(patch.branch); }
    if (patch.repo_path !== undefined)    { sets.push("repo_path = ?");    args.push(patch.repo_path); }
    if (patch.repo_origin !== undefined)  { sets.push("repo_origin = ?");  args.push(patch.repo_origin); }
    if (sets.length === 0) return;
    args.push(id);
    this.db.prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`).run(...args);
  }

  setMetadata(id: string, metadata: string | null): void {
    this.db.prepare(`UPDATE sessions SET metadata = ? WHERE id = ?`).run(metadata, id);
  }

  /**
   * Aggregate distinct hosts with session counts per status. Used by the
   * machines API to present a "what's running where" overview.
   */
  listMachines(): Array<{
    host: string;
    active: number;
    lost: number;
    ended: number;
    abandoned: number;
    last_seen_at: number;
  }> {
    return this.db
      .prepare(
        `SELECT host,
                SUM(CASE WHEN status = 'active'    THEN 1 ELSE 0 END) AS active,
                SUM(CASE WHEN status = 'lost'      THEN 1 ELSE 0 END) AS lost,
                SUM(CASE WHEN status = 'ended'     THEN 1 ELSE 0 END) AS ended,
                SUM(CASE WHEN status = 'abandoned' THEN 1 ELSE 0 END) AS abandoned,
                MAX(last_seen_at) AS last_seen_at
           FROM sessions
          GROUP BY host
          ORDER BY MAX(last_seen_at) DESC`,
      )
      .all() as Array<{
        host: string;
        active: number;
        lost: number;
        ended: number;
        abandoned: number;
        last_seen_at: number;
      }>;
  }

  /**
   * Shallow-merge `partial` into the session's existing metadata blob.
   * Keys present in `partial` overwrite; missing keys are preserved.
   * `null` value for a key DELETES that key. No-op when session is missing.
   *
   * Used by Lictor to publish its sidecar port after the pty/sidecar start
   * (the initial register happens BEFORE the sidecar is bound, so port is
   * not known yet).
   */
  mergeMetadata(id: string, partial: Record<string, unknown>): void {
    const row = this.findSession(id);
    if (!row) return;
    let current: Record<string, unknown> = {};
    if (row.metadata) {
      try {
        const parsed = JSON.parse(row.metadata) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          current = parsed as Record<string, unknown>;
        }
      } catch {
        // existing metadata is garbage — treat as empty rather than crash.
      }
    }
    for (const [k, v] of Object.entries(partial)) {
      if (v === null) delete current[k];
      else current[k] = v;
    }
    this.setMetadata(id, JSON.stringify(current));
  }

  countEvents(sessionId: string): number {
    const r = this.db
      .prepare(`SELECT COUNT(*) AS n FROM session_events WHERE session_id = ?`)
      .get(sessionId) as { n: number };
    return r.n;
  }

  /** started_at が [startTs, endTs) の session 集合. day_report 集計用. */
  listSessionsInRange(startTs: number, endTs: number): SessionRow[] {
    return this.db
      .prepare(
        `SELECT * FROM sessions WHERE started_at >= ? AND started_at < ? ORDER BY started_at ASC`,
      )
      .all(startTs, endTs) as SessionRow[];
  }

  /**
   * last_seen_at が sinceTs (epoch 秒) 以降のセッションを返す。 コスト時間帯集計
   * (JSONL を時刻で漁る) の候補抽出に使う — started_at ではなく「直近に動いたか」で
   * 絞るので、 日跨ぎの長時間セッションも対象に入る。
   */
  listSessionsSeenSince(sinceTs: number): SessionRow[] {
    return this.db
      .prepare(`SELECT * FROM sessions WHERE last_seen_at >= ? ORDER BY last_seen_at DESC LIMIT 1000`)
      .all(sinceTs) as SessionRow[];
  }

  setStatus(id: string, status: SessionStatus, ts: number, endedAt?: number): void {
    this.db
      .prepare(
        `UPDATE sessions SET status = ?, last_seen_at = ?, ended_at = COALESCE(?, ended_at) WHERE id = ?`,
      )
      .run(status, ts, endedAt ?? null, id);
  }

  /** active で last_seen_at が cutoff より古いものを返す */
  /**
   * active かつ last_seen_at が古い session のうち **WS 永続クライアントが繋がっていない** ものだけ返す.
   * ws_clients > 0 の session は「作業中」 と見なして lost 化対象から除外する
   * (考え事 / build / 入力待ちで hook が静止しても誤 lost を防ぐ).
   */
  findStaleActive(cutoff: number): SessionRow[] {
    return this.db
      .prepare(
        `SELECT * FROM sessions
         WHERE status = 'active' AND last_seen_at < ? AND ws_clients = 0`,
      )
      .all(cutoff) as SessionRow[];
  }

  // ─── WS persistent client (active 判定の主軸) ─────────
  //
  // 接続時に incrementWsClients、 切断時に decrementWsClients を呼ぶ.
  // ws_clients > 0 の session は sweeper の lost 判定から除外される.

  incrementWsClients(sessionId: string): number {
    const now = Math.floor(Date.now() / 1000);
    const r = this.db
      .prepare(
        `UPDATE sessions
           SET ws_clients = ws_clients + 1, last_seen_at = ?
         WHERE id = ?`,
      )
      .run(now, sessionId);
    if (Number(r.changes ?? 0) === 0) return 0;
    const row = this.db
      .prepare(`SELECT ws_clients FROM sessions WHERE id = ?`)
      .get(sessionId) as { ws_clients: number } | undefined;
    return row?.ws_clients ?? 0;
  }

  decrementWsClients(sessionId: string): number {
    const now = Math.floor(Date.now() / 1000);
    // 二重減算で負数にならないよう CASE で 0 床を保証.
    const r = this.db
      .prepare(
        `UPDATE sessions
           SET ws_clients = CASE WHEN ws_clients > 0 THEN ws_clients - 1 ELSE 0 END,
               last_seen_at = ?
         WHERE id = ?`,
      )
      .run(now, sessionId);
    if (Number(r.changes ?? 0) === 0) return 0;
    const row = this.db
      .prepare(`SELECT ws_clients FROM sessions WHERE id = ?`)
      .get(sessionId) as { ws_clients: number } | undefined;
    return row?.ws_clients ?? 0;
  }

  /** プロセス再起動時に in-memory の WS 接続が消えた状態を反映するため、 全 session の ws_clients を 0 にリセット. */
  resetAllWsClients(): number {
    const r = this.db
      .prepare(`UPDATE sessions SET ws_clients = 0 WHERE ws_clients > 0`)
      .run();
    return Number(r.changes ?? 0);
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

  /** lost / abandoned で last_seen_at が cutoff より古いセッションを完全削除 (events / reports / pending_tasks も) */
  purgeStale(cutoff: number): number {
    const ids = this.db
      .prepare(
        `SELECT id FROM sessions WHERE status IN ('lost', 'abandoned') AND last_seen_at < ?`,
      )
      .all(cutoff) as Array<{ id: string }>;
    if (ids.length === 0) return 0;
    const idList = ids.map((r) => r.id);
    const placeholder = idList.map(() => "?").join(",");
    const tx = this.db.transaction((args: string[]) => {
      this.db.prepare(`DELETE FROM session_events  WHERE session_id IN (${placeholder})`).run(...args);
      this.db.prepare(`DELETE FROM session_reports WHERE session_id IN (${placeholder})`).run(...args);
      this.db.prepare(`DELETE FROM pending_tasks   WHERE session_id IN (${placeholder})`).run(...args);
      this.db.prepare(`DELETE FROM sessions        WHERE id         IN (${placeholder})`).run(...args);
    });
    tx(idList);
    return idList.length;
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

  latestEventsByKind(sessionIds: string[], kind: string): SessionEventRow[] {
    if (sessionIds.length === 0) return [];
    const placeholders = sessionIds.map(() => "?").join(",");
    return this.db
      .prepare(
        `SELECT e.*
           FROM session_events e
          WHERE e.kind = ?
            AND e.session_id IN (${placeholders})
            AND e.id = (
              SELECT e2.id
                FROM session_events e2
               WHERE e2.session_id = e.session_id
                 AND e2.kind = ?
               ORDER BY e2.ts DESC, e2.id DESC
               LIMIT 1
            )
          ORDER BY e.ts DESC, e.id DESC`,
      )
      .all(kind, ...sessionIds, kind) as SessionEventRow[];
  }

  /**
   * 指定 session の指定 kind の最新 ts を返す. 該当無しは null.
   * idle 判定 (kind="prompt" の最終 ts と now の差) に使う.
   */
  lastEventTsByKind(sessionId: string, kind: string): number | null {
    const row = this.db
      .prepare(
        `SELECT ts FROM session_events
         WHERE session_id = ? AND kind = ?
         ORDER BY ts DESC LIMIT 1`,
      )
      .get(sessionId, kind) as { ts: number } | undefined;
    return row?.ts ?? null;
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

  listReports(limit = 30): SessionReportRow[] {
    return this.db
      .prepare(`SELECT * FROM session_reports ORDER BY generated_at DESC LIMIT ?`)
      .all(limit) as SessionReportRow[];
  }

  /** 旧 per-session report は無意味なので truncate. day-report に統合された. */
  truncateReports(): number {
    const r = this.db.prepare(`DELETE FROM session_reports`).run();
    return Number(r.changes ?? 0);
  }

  /** 単発レポート削除. human 操作用. */
  deleteReport(sessionId: string): boolean {
    const r = this.db.prepare(`DELETE FROM session_reports WHERE session_id = ?`).run(sessionId);
    return Number(r.changes ?? 0) > 0;
  }

  /** session 全件を削除 (truncate). user 指示で手動 reset 用. events / reports / pending_tasks も連動. */
  truncateAllSessions(): number {
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM session_events`).run();
      this.db.prepare(`DELETE FROM session_reports`).run();
      this.db.prepare(`DELETE FROM pending_tasks`).run();
      const r = this.db.prepare(`DELETE FROM sessions`).run();
      return Number(r.changes ?? 0);
    });
    return tx();
  }
}
