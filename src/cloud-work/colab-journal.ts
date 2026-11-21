import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ColabArtifacts, ColabReport } from "./colab-result.js";
import type { ColabRun } from "./colab-run.js";

export const COLAB_LEASE_MS = 60_000;
type Stored = { payload: string; lease_owner: string; lease_until: number };

export class ColabJournal {
  private db: Database.Database | undefined;

  constructor(private readonly root: string) {}

  private database(): Database.Database {
    if (this.db) return this.db;
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const db = new Database(join(this.root, "colab-runs.sqlite"));
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS runs (
          id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL UNIQUE, owner_scope TEXT NOT NULL, payload TEXT NOT NULL,
          active INTEGER NOT NULL, lease_owner TEXT NOT NULL, lease_until INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS single_active_colab_run ON runs(active) WHERE active = 1;
        CREATE INDEX IF NOT EXISTS colab_run_scope ON runs(owner_scope, created_at DESC);
      `);
    } catch (error) {
      db.close();
      throw error;
    }
    this.db = db;
    return db;
  }

  close(): void { this.db?.close(); this.db = undefined; }

  get(key: string): ColabRun | undefined {
    const row = this.database().prepare("SELECT payload FROM runs WHERE id = ?").get(key) as Stored | undefined;
    return row ? JSON.parse(row.payload) as ColabRun : undefined;
  }

  list(scope: string): ColabRun[] {
    const rows = this.database().prepare("SELECT payload FROM runs WHERE owner_scope = ? ORDER BY created_at DESC LIMIT 50").all(scope) as Stored[];
    return rows.map(row => JSON.parse(row.payload) as ColabRun);
  }

  reserve(run: ColabRun, scope: string, owner: string, now: number): "reserved" | "existing" | "busy" {
    const db = this.database();
    return db.transaction(() => {
      if (db.prepare("SELECT 1 FROM runs WHERE id = ?").get(run.key)) return "existing";
      if (db.prepare("SELECT 1 FROM runs WHERE active = 1").get()) return "busy";
      if (db.prepare("SELECT 1 FROM runs WHERE fingerprint = ?").get(run.requestFingerprint)) throw new Error("cloud_colab_duplicate_request");
      db.prepare("INSERT INTO runs VALUES (?, ?, ?, ?, 1, ?, ?, ?)").run(run.key, run.requestFingerprint, scope, JSON.stringify(run), owner, now + COLAB_LEASE_MS, now);
      return "reserved";
    }).immediate();
  }

  claimRecovery(owner: string, now: number, key?: string): ColabRun | undefined {
    if (!this.db && !existsSync(join(this.root, "colab-runs.sqlite"))) return undefined;
    const db = this.database();
    return db.transaction(() => {
      const row = db.prepare("SELECT payload, lease_owner, lease_until FROM runs WHERE active = 1 AND (? IS NULL OR id = ?)")
        .get(key ?? null, key ?? null) as Stored | undefined;
      if (!row || row.lease_owner !== owner && row.lease_until > now) return undefined;
      const run = JSON.parse(row.payload) as ColabRun;
      db.prepare("UPDATE runs SET lease_owner = ?, lease_until = ? WHERE id = ?").run(owner, now + COLAB_LEASE_MS, run.key);
      return run;
    }).immediate();
  }

  renew(run: ColabRun, owner: string, now: number): boolean {
    return this.database().prepare("UPDATE runs SET lease_until = ? WHERE id = ? AND active = 1 AND lease_owner = ? AND lease_until > ?")
      .run(now + COLAB_LEASE_MS, run.key, owner, now).changes === 1;
  }

  save(run: ColabRun, owner: string, now: number): void {
    const db = this.database();
    db.transaction(() => {
      if (run.site && this.get(run.key)?.site?.stopRequested) run.site.stopRequested = true;
      const changed = db.prepare(
        "UPDATE runs SET payload = ?, active = ? WHERE id = ? AND active = 1 AND lease_owner = ? AND lease_until > ?",
      ).run(JSON.stringify(run), run.resourceRelease === "released" ? 0 : 1, run.key, owner, now).changes;
      if (!changed) throw new Error("cloud_colab_ownership_lost");
    }).immediate();
  }

  requestSiteStop(key: string): ColabRun {
    const db = this.database();
    return db.transaction(() => {
      const run = this.get(key);
      if (!run?.site) throw new Error("cloud_attempt_not_found");
      if (run.resourceRelease !== "released") {
        run.site.stopRequested = true;
        db.prepare("UPDATE runs SET payload = ? WHERE id = ?").run(JSON.stringify(run), key);
      }
      return run;
    }).immediate();
  }

  recordSiteReport(key: string, report: ColabReport): void {
    const db = this.database();
    db.transaction(() => {
      const run = this.get(key);
      if (!run?.site || run.resourceRelease !== "released") throw new Error("cloud_colab_collection_unready");
      if (!run.workerReport) {
        run.workerReport = report;
        db.prepare("UPDATE runs SET payload = ? WHERE id = ?").run(JSON.stringify(run), key);
      }
    }).immediate();
  }

  verify(key: string, verified: ColabArtifacts): ColabRun {
    const db = this.database();
    return db.transaction(() => {
      const run = this.get(key);
      if (!run || run.resourceRelease !== "released") throw new Error("cloud_colab_collection_unready");
      if (!run.verified) {
        run.verified = verified;
        run.error = null;
        db.prepare("UPDATE runs SET payload = ? WHERE id = ?").run(JSON.stringify(run), key);
      }
      return run;
    }).immediate();
  }

  quality(key: string, quality: "accepted" | "rejected"): ColabRun {
    const db = this.database();
    return db.transaction(() => {
      const run = this.get(key);
      if (!run) throw new Error("cloud_attempt_not_found");
      if (!run.verified || run.resourceRelease !== "released") throw new Error("cloud_colab_quality_unready");
      run.quality = quality;
      db.prepare("UPDATE runs SET payload = ? WHERE id = ?").run(JSON.stringify(run), key);
      return run;
    }).immediate();
  }
}
