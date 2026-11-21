import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AwsJob } from "./aws-excubitor-schema.js";
import type { AwsProposal, AwsRun } from "./aws-run.js";

type Stored<T> = { value: T; version: number };
type Row = { payload: string; version: number };

export class AwsJournal {
  private db: Database.Database | undefined;

  constructor(private readonly path: string) {}

  private database(): Database.Database {
    if (this.db) return this.db;
    if (this.path !== ":memory:") mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const db = new Database(this.path);
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS aws_runs (
          id TEXT PRIMARY KEY, scope TEXT NOT NULL, target TEXT NOT NULL, fingerprint TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL, active INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS aws_one_active_target ON aws_runs(target) WHERE active = 1;
        CREATE INDEX IF NOT EXISTS aws_runs_scope ON aws_runs(scope, created_at DESC);
        CREATE TABLE IF NOT EXISTS aws_proposals (
          id TEXT PRIMARY KEY, session TEXT NOT NULL, scope TEXT NOT NULL, expires_at INTEGER NOT NULL, payload TEXT NOT NULL
        );
      `);
    } catch (error) {
      db.close();
      throw error;
    }
    this.db = db;
    return db;
  }

  close(): void { this.db?.close(); this.db = undefined; }

  get(key: string): Stored<AwsRun> | undefined {
    const row = this.database().prepare("SELECT payload, version FROM aws_runs WHERE id = ?").get(key) as Row | undefined;
    return row ? { value: JSON.parse(row.payload) as AwsRun, version: row.version } : undefined;
  }

  list(scope: string): AwsRun[] {
    return (this.database().prepare("SELECT payload FROM aws_runs WHERE scope = ? ORDER BY active DESC, created_at DESC").all(scope) as Row[])
      .map(row => JSON.parse(row.payload) as AwsRun);
  }

  reserve(run: AwsRun): boolean {
    const db = this.database();
    return db.transaction(() => {
      if (this.get(run.key)) return false;
      if (db.prepare("SELECT 1 FROM aws_runs WHERE fingerprint = ?").get(run.requestFingerprint)) {
        throw new Error("cloud_aws_duplicate_request");
      }
      if (db.prepare("SELECT 1 FROM aws_runs WHERE target = ? AND active = 1").get(run.targetId)) {
        throw new Error("cloud_aws_busy");
      }
      db.prepare("INSERT INTO aws_runs (id, scope, target, fingerprint, created_at, active, payload) VALUES (?, ?, ?, ?, ?, 1, ?)")
        .run(run.key, run.scopeKey, run.targetId, run.requestFingerprint, run.createdAt, JSON.stringify(run));
      db.prepare("DELETE FROM aws_proposals WHERE id = ?").run(run.key);
      return true;
    }).immediate();
  }

  update(key: string, change: (run: AwsRun) => AwsRun): Stored<AwsRun> {
    const db = this.database();
    return db.transaction(() => {
      const current = this.get(key);
      if (!current) throw new Error("cloud_attempt_not_found");
      const next = change(current.value);
      const inactive = next.refusal || next.job?.release === "confirmed" || next.job?.release === "not_allocated";
      db.prepare("UPDATE aws_runs SET payload = ?, version = version + 1, active = ? WHERE id = ?")
        .run(JSON.stringify(next), inactive ? 0 : 1, key);
      return { value: next, version: current.version + 1 };
    }).immediate();
  }

  recordObservation(current: Stored<AwsRun>, job: AwsJob): void {
    // An older request must never overwrite newer state, including a concurrent stop or collect.
    const inactive = job.release === "confirmed" || job.release === "not_allocated";
    const value: AwsRun = { ...current.value, job, issue: undefined };
    this.database().prepare("UPDATE aws_runs SET payload = ?, version = version + 1, active = ? WHERE id = ? AND version = ?")
      .run(JSON.stringify(value), inactive ? 0 : 1, value.key, current.version);
  }

  recordIssue(current: Stored<AwsRun>, issue: NonNullable<AwsRun["issue"]>): void {
    const value = { ...current.value, issue };
    this.database().prepare("UPDATE aws_runs SET payload = ?, version = version + 1 WHERE id = ? AND version = ?")
      .run(JSON.stringify(value), value.key, current.version);
  }

  propose(proposal: AwsProposal, now: number): AwsProposal {
    const db = this.database();
    return db.transaction(() => {
      db.prepare("DELETE FROM aws_proposals WHERE expires_at <= ?").run(now);
      if (this.get(proposal.key)) throw new Error("cloud_attempt_conflict");
      const existing = this.proposal(proposal.key, now);
      if (existing) return existing;
      const count = db.prepare("SELECT COUNT(*) AS count FROM aws_proposals WHERE session = ?").get(proposal.sessionId) as { count: number };
      if (count.count >= 10) throw new Error("cloud_aws_proposal_limit");
      db.prepare("INSERT INTO aws_proposals VALUES (?, ?, ?, ?, ?)")
        .run(proposal.key, proposal.sessionId, proposal.scopeKey, proposal.expiresAt, JSON.stringify(proposal));
      return proposal;
    }).immediate();
  }

  proposal(key: string, now: number): AwsProposal | undefined {
    const row = this.database().prepare("SELECT payload FROM aws_proposals WHERE id = ? AND expires_at > ?").get(key, now) as Row | undefined;
    return row ? JSON.parse(row.payload) as AwsProposal : undefined;
  }

  proposals(scope: string, session: string, now: number): AwsProposal[] {
    return (this.database().prepare("SELECT payload FROM aws_proposals WHERE scope = ? AND session = ? AND expires_at > ? ORDER BY expires_at")
      .all(scope, session, now) as Row[]).map(row => JSON.parse(row.payload) as AwsProposal);
  }
}
