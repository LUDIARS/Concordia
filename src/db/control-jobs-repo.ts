import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export type ControlJobStatus = "queued" | "running" | "succeeded" | "failed";
export type ProcessRole = "lictor" | "agent-client" | "orphan";

export interface StopProcessTreePayload {
  pid: number;
  source: string;
  sessionId: string | null;
  role: ProcessRole;
  expectedCommand: string | null;
}

export interface ControlJobRow {
  id: string;
  kind: "stop_process_tree";
  payload_json: string;
  dedupe_key: string;
  status: ControlJobStatus;
  attempts: number;
  max_attempts: number;
  available_at: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
  result_json: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
  expires_at: number;
}

export interface EnqueuedControlJob {
  id: string;
  deduplicated: boolean;
}

export interface EnqueueStopProcessInput extends StopProcessTreePayload {
  dedupeKey?: string;
  maxAttempts?: number;
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 5 * 60_000;

/** Persistent, lease-based queue shared by Concordia core and control-worker. */
export class ControlJobsRepo {
  constructor(private readonly db: Database.Database) {}

  enqueueStopProcess(input: EnqueueStopProcessInput, now = Date.now()): EnqueuedControlJob {
    if (!Number.isInteger(input.pid) || input.pid <= 0) {
      throw new Error(`invalid pid: ${input.pid}`);
    }
    const dedupeKey = input.dedupeKey ?? [
      "stop_process_tree",
      input.sessionId ?? "none",
      input.role,
      input.pid,
    ].join(":");
    const payload: StopProcessTreePayload = {
      pid: input.pid,
      source: input.source,
      sessionId: input.sessionId,
      role: input.role,
      expectedCommand: input.expectedCommand,
    };
    const id = randomUUID();
    const enqueue = this.db.transaction((): EnqueuedControlJob => {
      const active = this.db.prepare(
        `SELECT id FROM control_jobs
         WHERE dedupe_key = ? AND status IN ('queued', 'running')
         LIMIT 1`,
      ).get(dedupeKey) as { id: string } | undefined;
      if (active) return { id: active.id, deduplicated: true };
      this.db.prepare(
        `INSERT INTO control_jobs(
           id, kind, payload_json, dedupe_key, status, attempts, max_attempts,
           available_at, created_at, updated_at, expires_at
         ) VALUES (?, 'stop_process_tree', ?, ?, 'queued', 0, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        JSON.stringify(payload),
        dedupeKey,
        Math.max(1, input.maxAttempts ?? 3),
        now,
        now,
        now,
        now + Math.max(1_000, input.ttlMs ?? DEFAULT_TTL_MS),
      );
      return { id, deduplicated: false };
    });
    return enqueue.immediate();
  }

  claimNext(owner: string, leaseMs: number, now = Date.now()): ControlJobRow | null {
    const claim = this.db.transaction((): ControlJobRow | null => {
      this.db.prepare(
        `UPDATE control_jobs
         SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL,
             available_at = ?, updated_at = ?, last_error = COALESCE(last_error, 'worker lease expired')
         WHERE status = 'running' AND lease_expires_at <= ? AND attempts < max_attempts`,
      ).run(now, now, now);
      this.db.prepare(
        `UPDATE control_jobs
         SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
             finished_at = ?, updated_at = ?, last_error = COALESCE(last_error, 'worker lease expired after final attempt')
         WHERE status = 'running' AND lease_expires_at <= ? AND attempts >= max_attempts`,
      ).run(now, now, now);

      const candidate = this.db.prepare(
        `SELECT id FROM control_jobs
         WHERE status = 'queued' AND available_at <= ?
         ORDER BY created_at ASC, id ASC
         LIMIT 1`,
      ).get(now) as { id: string } | undefined;
      if (!candidate) return null;
      const changed = this.db.prepare(
        `UPDATE control_jobs
         SET status = 'running', attempts = attempts + 1,
             lease_owner = ?, lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND status = 'queued'`,
      ).run(owner, now + Math.max(1_000, leaseMs), now, candidate.id);
      if (changed.changes !== 1) return null;
      return this.findById(candidate.id);
    });
    return claim.immediate();
  }

  markSucceeded(id: string, owner: string, result: unknown, now = Date.now()): boolean {
    const changed = this.db.prepare(
      `UPDATE control_jobs
       SET status = 'succeeded', result_json = ?, last_error = NULL,
           lease_owner = NULL, lease_expires_at = NULL, finished_at = ?, updated_at = ?
       WHERE id = ? AND status = 'running' AND lease_owner = ?`,
    ).run(JSON.stringify(result), now, now, id, owner);
    return changed.changes === 1;
  }

  markFailed(
    id: string,
    owner: string,
    error: string,
    options: { retryable: boolean; retryDelayMs?: number },
    now = Date.now(),
  ): boolean {
    const row = this.findById(id);
    if (!row || row.status !== "running" || row.lease_owner !== owner) return false;
    const retry = options.retryable && row.attempts < row.max_attempts && now < row.expires_at;
    const changed = this.db.prepare(
      retry
        ? `UPDATE control_jobs
           SET status = 'queued', available_at = ?, last_error = ?,
               lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
           WHERE id = ? AND status = 'running' AND lease_owner = ?`
        : `UPDATE control_jobs
           SET status = 'failed', last_error = ?, lease_owner = NULL,
               lease_expires_at = NULL, finished_at = ?, updated_at = ?
           WHERE id = ? AND status = 'running' AND lease_owner = ?`,
    );
    const message = error.slice(0, 2_000);
    const result = retry
      ? changed.run(now + Math.max(0, options.retryDelayMs ?? 1_000), message, now, id, owner)
      : changed.run(message, now, now, id, owner);
    return result.changes === 1;
  }

  findById(id: string): ControlJobRow | null {
    return (this.db.prepare(`SELECT * FROM control_jobs WHERE id = ?`).get(id) as ControlJobRow | undefined) ?? null;
  }
}
