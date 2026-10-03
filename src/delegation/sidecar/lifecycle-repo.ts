/** Resident lease and pre-delivery request receipts. All reservations use SQLite CAS. */
import type Database from "better-sqlite3";
import type { ResidentChild } from "./lifecycle-policy.js";
export interface ResidentReceipt { parent_id: string; request_key: string; child_id: string;
  generation: string; run_id: string; delivery: "prepared" | "delivered" | "unknown" | "result" | "failed"; reason?:string | null; }
export class ResidentSidecarRepo {
  constructor(private readonly db: Database.Database) {}
  findByParent(parent: string): ResidentChild | null {
    return this.db.prepare("SELECT * FROM resident_sidecars WHERE parent_id=? AND state!='closed' ORDER BY created_at DESC LIMIT 1")
      .get(parent) as ResidentChild | undefined ?? null;
  }
  list(): ResidentChild[] { return this.db.prepare("SELECT * FROM resident_sidecars WHERE state!='closed'").all() as ResidentChild[]; }
  receipt(parent: string, key: string): ResidentReceipt | null {
    return this.db.prepare("SELECT * FROM resident_sidecar_requests WHERE parent_id=? AND request_key=?").get(parent, key) as ResidentReceipt | undefined ?? null;
  }
  reserve(child: ResidentChild, receipt: ResidentReceipt, nowMs: number, prepareRun?: () => void): boolean {
    return this.db.transaction(() => {
      if (this.receipt(receipt.parent_id, receipt.request_key)) return false;
      if (child.state === "starting") {
        if (this.findByParent(child.parent_id)) return false;
        this.db.prepare("INSERT INTO resident_sidecars(id,parent_id,generation,repo_path,organization,provider,model,state,child_session_id,current_run_id,branch,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
          .run(child.id,child.parent_id,child.generation,child.repo_path,child.organization,child.provider,child.model,child.state,null,child.current_run_id,child.branch,nowMs);
      } else {
        const changed = this.db.prepare("UPDATE resident_sidecars SET state='busy',current_run_id=? WHERE id=? AND generation=? AND state='idle'")
          .run(receipt.run_id,child.id,child.generation).changes;
        if (!changed) return false;
      }
      prepareRun?.();
      this.db.prepare("INSERT INTO resident_sidecar_requests(parent_id,request_key,child_id,generation,run_id,delivery) VALUES(?,?,?,?,?,'prepared')")
        .run(receipt.parent_id,receipt.request_key,receipt.child_id,receipt.generation,receipt.run_id);
      return true;
    }).immediate();
  }
  attach(id: string, generation: string, runId: string, sessionId: string): boolean {
    return this.db.prepare("UPDATE resident_sidecars SET child_session_id=?,state='busy' WHERE id=? AND generation=? AND current_run_id=? AND state='starting'")
      .run(sessionId,id,generation,runId).changes === 1;
  }
  delivery(parent: string, key: string, state: ResidentReceipt["delivery"]): void {
    this.db.prepare("UPDATE resident_sidecar_requests SET delivery=? WHERE parent_id=? AND request_key=? AND delivery!='result'").run(state,parent,key);
  }
  result(runId: string, generation: string): boolean {
    return this.db.transaction(() => {
      const changed = this.db.prepare("UPDATE resident_sidecars SET state='idle' WHERE current_run_id=? AND generation=? AND state='busy'").run(runId,generation).changes;
      if (!changed) return false;
      this.db.prepare("UPDATE resident_sidecar_requests SET delivery='result' WHERE run_id=? AND generation=?").run(runId,generation);
      return true;
    }).immediate();
  }
  failRequest(parent:string,key:string,reason:string): void {
    this.db.prepare("UPDATE resident_sidecar_requests SET delivery='failed',reason=? WHERE parent_id=? AND request_key=? AND delivery IN ('prepared','result')")
      .run(reason,parent,key);
  }
  close(id: string, generation: string, closed: boolean, reason: string): void {
    this.db.prepare("UPDATE resident_sidecars SET state=?,close_reason=? WHERE id=? AND generation=? AND state!='closed'")
      .run(closed ? "closed" : "closing",reason,id,generation);
  }
}
