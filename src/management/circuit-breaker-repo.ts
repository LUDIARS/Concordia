import type { Database } from "better-sqlite3";
import { TARGET_WINDOW_MS, TRIGGER_WINDOW_MS, type BreakerConfig, type BreakerReason, type BreakerTarget } from "./circuit-breaker.js";

type StartKind = "external_start" | "managed_start";
type ResultKind = "failure" | "success";
type EventKind = StartKind | ResultKind | "trip" | "reset";

type BreakerRow = BreakerConfig & {
  epoch: number;
  failures: number;
  opened_at: number | null;
  reason: BreakerReason | null;
  project_code: string | null;
  target_key: string | null;
  session_id: string | null;
};

export interface BreakerSnapshot {
  status: "CLOSED" | "OPEN";
  config: BreakerConfig;
  consecutive_failures: number;
  opened_at: number | null;
  reason: BreakerReason | null;
  target: BreakerTarget | null;
}

interface BreakerEvent {
  id: number;
  project_code: string | null;
  target_key: string | null;
  session_id: string | null;
}

type TripEvent = BreakerEvent & { reason: BreakerReason };

export class CircuitBreakerRepository {
  constructor(private readonly db: Database) {}

  transaction<T>(run: () => T): T {
    return this.db.transaction(run).immediate();
  }

  snapshot(): BreakerSnapshot {
    const row = this.db.prepare("SELECT * FROM autonomous_loop_breaker WHERE id = 1").get() as BreakerRow;
    return {
      status: row.opened_at === null ? "CLOSED" : "OPEN",
      config: {
        consecutive_failures: row.consecutive_failures,
        target_oscillation: row.target_oscillation,
        concurrency_limit: row.concurrency_limit,
        trigger_rate_limit: row.trigger_rate_limit,
        cooldown_ms: row.cooldown_ms,
      },
      consecutive_failures: row.failures,
      opened_at: row.opened_at,
      reason: row.reason,
      target: eventTarget(row),
    };
  }

  updateConfig(config: BreakerConfig): void {
    this.db.prepare(`UPDATE autonomous_loop_breaker SET consecutive_failures=@consecutive_failures,
      target_oscillation=@target_oscillation, concurrency_limit=@concurrency_limit,
      trigger_rate_limit=@trigger_rate_limit, cooldown_ms=@cooldown_ms WHERE id=1`).run(config);
  }

  trip(reason: BreakerReason, target: BreakerTarget | null, now: number): void {
    const result = this.db.prepare(`UPDATE autonomous_loop_breaker SET opened_at=?, reason=?,
      project_code=?, target_key=?, session_id=? WHERE id=1 AND opened_at IS NULL`)
      .run(now, reason, target?.project_code ?? null, target?.target_key ?? null, target?.session_id ?? null);
    if (result.changes === 1) this.insertEvent("trip", target, now, null, reason);
  }

  reset(now: number): void {
    this.db.prepare(`UPDATE autonomous_loop_breaker SET opened_at=NULL, reason=NULL, project_code=NULL,
      target_key=NULL, session_id=NULL, failures=0, epoch=epoch+1 WHERE id=1`).run();
    this.insertEvent("reset", null, now);
  }

  recordStart(kind: StartKind, target: BreakerTarget, now: number, runId?: string): void {
    this.insertEvent(kind, target, now, runId);
  }

  recordResult(kind: ResultKind, target: BreakerTarget, now: number, runId?: string): void {
    this.insertEvent(kind, target, now, runId);
    this.db.prepare(`UPDATE autonomous_loop_breaker
      SET failures=CASE WHEN ? = 'failure' THEN failures+1 ELSE 0 END WHERE id=1`).run(kind);
  }

  startOf(runId: string): BreakerTarget | null {
    const event = this.db.prepare(`SELECT project_code,target_key,session_id
      FROM autonomous_loop_breaker_events WHERE kind='external_start' AND run_id=?`).get(runId) as BreakerEvent | undefined;
    return event ? eventTarget(event) : null;
  }

  resultOf(runId: string): ResultKind | null {
    const event = this.db.prepare(`SELECT kind FROM autonomous_loop_breaker_events
      WHERE kind IN ('failure','success') AND run_id=?`).get(runId) as { kind: ResultKind } | undefined;
    return event?.kind ?? null;
  }

  activeExternalRuns(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM autonomous_loop_breaker_events AS started
      WHERE started.kind='external_start' AND NOT EXISTS (
        SELECT 1 FROM autonomous_loop_breaker_events AS finished
        WHERE finished.kind IN ('failure','success') AND finished.run_id=started.run_id
      )`).get() as { count: number };
    return row.count;
  }

  startCounts(target: BreakerTarget, now: number): { targetAttempts: number; totalAttempts: number } {
    const row = this.db.prepare(`SELECT COUNT(CASE WHEN created_at > ? AND project_code = ? AND target_key = ? THEN 1 END) AS targetAttempts,
      COUNT(CASE WHEN created_at > ? THEN 1 END) AS totalAttempts
      FROM autonomous_loop_breaker_events
      WHERE epoch=(SELECT epoch FROM autonomous_loop_breaker WHERE id=1)
        AND kind IN ('external_start','managed_start') AND created_at > ? AND created_at <= ?`)
      .get(now - TARGET_WINDOW_MS, target.project_code, target.target_key, now - TRIGGER_WINDOW_MS, now - TARGET_WINDOW_MS, now) as
      { targetAttempts: number; totalAttempts: number };
    return { targetAttempts: row.targetAttempts + 1, totalAttempts: row.totalAttempts + 1 };
  }

  nextAlert(): { id: number; reason: BreakerReason; target: BreakerTarget | null } | null {
    const event = this.db.prepare(`SELECT id,reason,project_code,target_key,session_id FROM autonomous_loop_breaker_events
      WHERE kind='trip' AND notified_at IS NULL ORDER BY id LIMIT 1`).get() as TripEvent | undefined;
    return event ? { id: event.id, reason: event.reason, target: eventTarget(event) } : null;
  }

  markAlertDelivered(id: number, now: number): void {
    this.db.prepare("UPDATE autonomous_loop_breaker_events SET notified_at=? WHERE id=? AND notified_at IS NULL").run(now, id);
  }

  private insertEvent(kind: EventKind, target: BreakerTarget | null, now: number, runId?: string | null, reason?: BreakerReason): void {
    this.db.prepare(`INSERT INTO autonomous_loop_breaker_events (epoch,kind,run_id,project_code,target_key,session_id,reason,created_at)
      VALUES ((SELECT epoch FROM autonomous_loop_breaker WHERE id=1),?,?,?,?,?,?,?)`)
      .run(kind, runId ?? null, target?.project_code ?? null, target?.target_key ?? null, target?.session_id ?? null, reason ?? null, now);
  }
}

function eventTarget(row: Pick<BreakerRow, "project_code" | "target_key" | "session_id">): BreakerTarget | null {
  if (row.project_code === null || row.target_key === null) return null;
  return { project_code: row.project_code, target_key: row.target_key, session_id: row.session_id };
}
