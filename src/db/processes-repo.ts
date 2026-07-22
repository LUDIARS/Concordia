/**
 * processes / process_logs の DB アクセス層.
 */

import type Database from "better-sqlite3";
import type {
  LogLevel,
  LogStream,
  ProcessLogRow,
  ProcessRow,
  ProcessStatus,
} from "../shared/types.js";

export interface UpsertProcessInput {
  name: string;
  cwd: string;
  command: string;
  repo_path: string | null;
  repo_origin: string | null;
  log_path: string;
  metadata?: string | null;
  instance_id: string;
  generation: number;
}

export class ProcessesRepo {
  constructor(private readonly db: Database.Database) {}

  upsert(input: UpsertProcessInput): void {
    this.db
      .prepare(
        `INSERT INTO processes(
           name, cwd, command, repo_path, repo_origin,
           pid, instance_id, generation, status, started_at, exited_at, exit_code, exit_signal,
           log_path, metadata
         ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 'starting', NULL, NULL, NULL, NULL, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           cwd = excluded.cwd,
           command = excluded.command,
           repo_path = excluded.repo_path,
           repo_origin = excluded.repo_origin,
           instance_id = excluded.instance_id,
           generation = excluded.generation,
           log_path = excluded.log_path,
           metadata = excluded.metadata`,
      )
      .run(
        input.name,
        input.cwd,
        input.command,
        input.repo_path,
        input.repo_origin,
        input.instance_id,
        input.generation,
        input.log_path,
        input.metadata ?? null,
      );
  }

  find(name: string): ProcessRow | null {
    return (
      (this.db.prepare(`SELECT * FROM processes WHERE name = ?`).get(name) as ProcessRow | undefined) ??
      null
    );
  }

  list(filter: { status?: ProcessStatus; repo_path?: string } = {}): ProcessRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.status) { where.push("status = ?"); params.push(filter.status); }
    if (filter.repo_path) { where.push("repo_path = ?"); params.push(filter.repo_path); }
    const sql =
      `SELECT * FROM processes` +
      (where.length ? ` WHERE ${where.join(" AND ")}` : ``) +
      ` ORDER BY (started_at IS NULL), started_at DESC, name ASC`;
    return this.db.prepare(sql).all(...params) as ProcessRow[];
  }

  setStarted(name: string, instanceId: string, generation: number, pid: number, startedAt: number): void {
    this.db
      .prepare(
        `UPDATE processes
            SET pid = ?, status = 'running', started_at = ?,
                exited_at = NULL, exit_code = NULL, exit_signal = NULL
          WHERE name = ? AND instance_id = ? AND generation = ?`,
      )
      .run(pid, startedAt, name, instanceId, generation);
  }

  setExited(
    name: string,
    instanceId: string,
    generation: number,
    info: { exit_code: number | null; exit_signal: string | null; exited_at: number; failed: boolean },
  ): void {
    this.db
      .prepare(
        `UPDATE processes
            SET pid = NULL,
                status = ?,
                exited_at = ?,
                exit_code = ?,
                exit_signal = ?
          WHERE name = ? AND instance_id = ? AND generation = ?`,
      )
      .run(
        info.failed ? "failed" : "exited",
        info.exited_at,
        info.exit_code,
        info.exit_signal,
        name,
        instanceId,
        generation,
      );
  }

  remove(name: string): void {
    this.db.prepare(`DELETE FROM process_logs WHERE process_name = ?`).run(name);
    this.db.prepare(`DELETE FROM processes WHERE name = ?`).run(name);
  }

  // ─── logs ────────────────────────────────────────────

  appendLog(input: {
    process_name: string;
    ts: number;
    stream: LogStream;
    level: LogLevel | null;
    line: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO process_logs(process_name, ts, stream, level, line)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.process_name, input.ts, input.stream, input.level, input.line);
  }

  recentLogs(
    name: string,
    opts: { since_ts?: number; level?: LogLevel; limit?: number } = {},
  ): ProcessLogRow[] {
    const where: string[] = ["process_name = ?"];
    const params: unknown[] = [name];
    if (typeof opts.since_ts === "number") {
      where.push("ts > ?");
      params.push(opts.since_ts);
    }
    if (opts.level) {
      where.push("level = ?");
      params.push(opts.level);
    }
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 2000);
    const rows = this.db
      .prepare(
        `SELECT * FROM process_logs
          WHERE ${where.join(" AND ")}
          ORDER BY ts DESC, id DESC
          LIMIT ?`,
      )
      .all(...params, limit) as ProcessLogRow[];
    return rows.reverse();
  }

  /** 古いログを GC. process ごとに最新 N 行残す. */
  trimLogs(name: string, keep = 5000): number {
    const info = this.db
      .prepare(
        `DELETE FROM process_logs
          WHERE process_name = ?
            AND id NOT IN (
              SELECT id FROM process_logs
               WHERE process_name = ?
               ORDER BY ts DESC, id DESC
               LIMIT ?
            )`,
      )
      .run(name, name, keep);
    return Number(info.changes ?? 0);
  }
}
