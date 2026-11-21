import type { Database } from "better-sqlite3";
import type { BuildJob, HookEvent } from "./models.js";

export interface SpawnReceiptRow {
  fingerprint: string;
  run_id: string;
  enrollment_id: string;
  state: "launching" | "failed" | "uncertain";
  session_id: string | null;
}

export class ConfluxRepository {
  constructor(private readonly db: Database) {}

  spawn(key: string): SpawnReceiptRow | undefined {
    return this.db.prepare("SELECT * FROM conflux_spawn_receipts WHERE key = ?").get(key) as SpawnReceiptRow | undefined;
  }

  reserveSpawn(key: string, fingerprint: string, runId: string, enrollmentId: string): boolean {
    return this.db.prepare(`
      INSERT INTO conflux_spawn_receipts (key, fingerprint, run_id, enrollment_id, state)
      VALUES (?, ?, ?, ?, 'launching') ON CONFLICT(key) DO NOTHING
    `).run(key, fingerprint, runId, enrollmentId).changes === 1;
  }

  finishLaunch(key: string, state: "failed" | "uncertain"): void {
    this.db.prepare("UPDATE conflux_spawn_receipts SET state = ? WHERE key = ? AND session_id IS NULL").run(state, key);
  }

  reconcileSpawn(receipt: SpawnReceiptRow): { id: string; status: string } | undefined {
    const byId = this.db.prepare("SELECT id, status FROM sessions WHERE id = ?");
    if (receipt.session_id) return byId.get(receipt.session_id) as { id: string; status: string } | undefined
      ?? { id: receipt.session_id, status: "unavailable" };
    const found = this.db.prepare(`
      SELECT id, status FROM sessions WHERE json_extract(metadata, '$.concordia_spawn_id') = ? LIMIT 1
    `).get(receipt.enrollment_id) as { id: string; status: string } | undefined;
    if (found) this.db.prepare("UPDATE conflux_spawn_receipts SET session_id = ? WHERE run_id = ? AND session_id IS NULL")
      .run(found.id, receipt.run_id);
    return found;
  }

  queueBuild(job: BuildJob, fingerprint: string, now: number): string {
    this.db.prepare(`
      INSERT INTO conflux_build_jobs (key, fingerprint, request, state, queued_at)
      VALUES (?, ?, ?, 'queued', ?) ON CONFLICT(key) DO NOTHING
    `).run(job.dedupe_key, fingerprint, JSON.stringify(job), now);
    return (this.db.prepare("SELECT fingerprint FROM conflux_build_jobs WHERE key = ?").get(job.dedupe_key) as { fingerprint: string }).fingerprint;
  }

  claimBuild(): BuildJob | undefined {
    return this.db.transaction(() => {
      const row = this.db.prepare(`
        UPDATE conflux_build_jobs SET state = 'running' WHERE key = (
          SELECT key FROM conflux_build_jobs WHERE state = 'queued' ORDER BY queued_at, key LIMIT 1
        ) RETURNING request
      `).get() as { request: string } | undefined;
      if (!row) return undefined;
      const job = JSON.parse(row.request) as BuildJob;
      this.recordBuildEvent(job, "running", 1);
      return job;
    }).immediate();
  }

  finishBuild(job: BuildJob, state: "succeeded" | "failed", summary?: string): void {
    this.db.transaction(() => {
      const { changes } = this.db.prepare("UPDATE conflux_build_jobs SET state = ? WHERE key = ? AND state = 'running'")
        .run(state, job.dedupe_key);
      if (changes) this.recordBuildEvent(job, state, 2, summary);
    }).immediate();
  }

  recoverBuilds(): void {
    const rows = this.db.prepare("SELECT request FROM conflux_build_jobs WHERE state = 'running'").all() as { request: string }[];
    for (const row of rows) this.finishBuild(JSON.parse(row.request) as BuildJob, "failed", "Cc stopped before recording the build result");
  }

  enqueue(event: HookEvent): void {
    this.db.prepare("INSERT INTO conflux_hook_outbox (key, path, payload) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING")
      .run(event.key, event.path, JSON.stringify(event.payload));
  }

  hasHook(key: string): boolean {
    return this.db.prepare("SELECT 1 FROM conflux_hook_outbox WHERE key = ?").get(key) !== undefined;
  }

  pendingHooks(now: number): { key: string; path: string; payload: string; attempts: number }[] {
    return this.db.prepare(`
      SELECT key, path, payload, attempts FROM conflux_hook_outbox
      WHERE delivered_at IS NULL AND next_attempt <= ? ORDER BY rowid LIMIT 20
    `).all(now) as { key: string; path: string; payload: string; attempts: number }[];
  }

  finishHook(key: string, now: number, retry?: number): void {
    if (retry === undefined) {
      this.db.prepare("UPDATE conflux_hook_outbox SET delivered_at = ? WHERE key = ?").run(now, key);
    } else {
      this.db.prepare("UPDATE conflux_hook_outbox SET attempts = attempts + 1, next_attempt = ? WHERE key = ?").run(now + retry, key);
    }
  }

  private recordBuildEvent(job: BuildJob, state: "running" | "succeeded" | "failed", seq: number, failureSummary?: string): void {
    this.enqueue({
      key: `build:${seq}:${job.dedupe_key}`,
      path: "/api/hooks/build-events",
      payload: { dedupeKey: job.dedupe_key, projectCode: job.projectCode, variantId: job.variantId,
        commit: job.commit, seq, state, ...(failureSummary ? { failureSummary } : {}) },
    });
  }
}
