/** Adopted snapshots, history and daily ownership. No provider I/O in transactions. */
import type Database from "better-sqlite3";
import type { RoleSnapshot } from "../model-catalog/role-policy.js";

export class ModelRoleRepo {
  constructor(private readonly db: Database.Database,
    private readonly followTemplates?: (before: RoleSnapshot,next: RoleSnapshot) => void) {}
  find(provider: string, role: string): RoleSnapshot | null {
    const row = this.db.prepare("SELECT snapshot_json FROM model_role_snapshots WHERE provider=? AND role=?")
      .get(provider, role) as { snapshot_json: string } | undefined;
    return row ? JSON.parse(row.snapshot_json) as RoleSnapshot : null;
  }
  list(): RoleSnapshot[] {
    return (this.db.prepare("SELECT snapshot_json FROM model_role_snapshots ORDER BY provider,role").all() as { snapshot_json: string }[])
      .map((row) => JSON.parse(row.snapshot_json) as RoleSnapshot);
  }
  seed(snapshot: RoleSnapshot): void {
    this.db.prepare("INSERT OR IGNORE INTO model_role_snapshots(provider,role,revision,snapshot_json) VALUES(?,?,?,?)")
      .run(snapshot.provider, snapshot.role, snapshot.revision, JSON.stringify(snapshot));
  }
  refreshStatus(): {day:string;status:string;attempts:number;reason:string | null} | null {
    return this.db.prepare("SELECT day,status,attempts,reason FROM model_refresh_days ORDER BY day DESC LIMIT 1").get() as
      {day:string;status:string;attempts:number;reason:string | null} | undefined ?? null;
  }
  adopt(expectedRevision: string, next: RoleSnapshot, reason: string, nowMs: number): boolean {
    return this.db.transaction(() => {
      const before = this.find(next.provider, next.role);
      if (!before || before.revision !== expectedRevision) return false;
      const changed = this.db.prepare("UPDATE model_role_snapshots SET revision=?,snapshot_json=? WHERE provider=? AND role=? AND revision=?")
        .run(next.revision, JSON.stringify(next), next.provider, next.role, expectedRevision).changes;
      if (!changed) return false;
      // Only default-following standard templates still at the previous pointer
      // move. Explicit template pins and every running session retain their model.
      this.followTemplates?.(before,next);
      this.db.prepare("INSERT INTO model_role_history(provider,role,revision,before_json,after_json,reason,created_at) VALUES(?,?,?,?,?,?,?)")
        .run(next.provider, next.role, next.revision, JSON.stringify(before), JSON.stringify(next), reason, nowMs);
      return true;
    }).immediate();
  }
  rollback(provider: string, role: string, historicalRevision: string, revision: string, nowMs: number): boolean {
    const historical = this.db.prepare("SELECT after_json FROM model_role_history WHERE provider=? AND role=? AND revision=?")
      .get(provider, role, historicalRevision) as { after_json: string } | undefined;
    const current = this.find(provider, role);
    if (!historical || !current) return false;
    const snapshot = JSON.parse(historical.after_json) as RoleSnapshot;
    return this.adopt(current.revision, { ...snapshot, revision, pinned: true }, "explicit_rollback", nowMs);
  }
  claim(day: string, owner: string, nowMs: number, leaseMs: number): boolean {
    return this.db.transaction(() => {
      this.db.prepare("INSERT OR IGNORE INTO model_refresh_days(day,status,owner,lease_until,attempts) VALUES(?,'pending','',0,0)").run(day);
      return this.db.prepare("UPDATE model_refresh_days SET owner=?,lease_until=?,status='running',attempts=attempts+1 WHERE day=? AND status!='done' AND lease_until<=? AND attempts<3")
        .run(owner, nowMs + leaseMs, day, nowMs).changes === 1;
    }).immediate();
  }
  owns(day: string, owner: string, nowMs: number): boolean {
    return !!this.db.prepare("SELECT day FROM model_refresh_days WHERE day=? AND owner=? AND lease_until>? AND status='running'")
      .get(day, owner, nowMs);
  }
  finish(day: string, owner: string, nowMs: number, reason: string, ok: boolean): void {
    this.db.prepare("UPDATE model_refresh_days SET status=?,reason=?,lease_until=? WHERE day=? AND owner=? AND status='running'")
      .run(ok ? "done" : "failed", reason, ok ? 0 : nowMs + 15 * 60_000, day, owner);
  }
}
