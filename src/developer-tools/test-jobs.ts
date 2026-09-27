import { createHash } from "node:crypto";
import type { Database } from "better-sqlite3";
import { unavailable, failure, ToolUnavailable } from "./contracts.js";

interface Job { fingerprint: string; state: string; result: string | null; identity_json: string | null }
/** Durable request identity. Interrupted jobs are never executed again automatically. */
export class ToolTestJobs {
  private readonly active = new Map<string, Promise<void>>();
  private closed = false;
  constructor(private readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS developer_tool_test_jobs (
      owner TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      state TEXT NOT NULL, result TEXT, PRIMARY KEY (owner, request_id)
    )`);
    const columns = db.prepare("PRAGMA table_info(developer_tool_test_jobs)").all() as { name: string }[];
    if (!columns.some(column => column.name === "identity_json")) {
      db.exec("ALTER TABLE developer_tool_test_jobs ADD COLUMN identity_json TEXT");
    }
  }
  read(owner: string, requestId: string): unknown {
    const job = this.db.prepare("SELECT fingerprint,state,result,identity_json FROM developer_tool_test_jobs WHERE owner=? AND request_id=?")
      .get(owner, requestId) as Job | undefined;
    if (!job) unavailable("test_request_not_found", "この session が受け付けた request_id を指定してください。");
    return { request_id: requestId, state: job.state === "running" && !this.active.has(`${owner}:${requestId}`) ? "outcome_unknown" : job.state,
      result: job.result ? JSON.parse(job.result) as unknown : null,
      request: job.identity_json ? JSON.parse(job.identity_json) as unknown : null,
      ...(job.state === "running" ? { next_action: "同じ request_id で結果を照会してください。Cc 中断後は Augur の run 記録を照合し、新規依頼で再実行しないでください。" } : {}) };
  }
  start(owner: string, requestId: string, identity: unknown, run: () => Promise<unknown>): unknown {
    const fingerprint = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
    const existing = this.db.prepare("SELECT fingerprint FROM developer_tool_test_jobs WHERE owner=? AND request_id=?")
      .get(owner, requestId) as Pick<Job, "fingerprint"> | undefined;
    if (existing) {
      if (existing.fingerprint !== fingerprint) unavailable("request_identity_conflict", "同じ request_id の bundle・checkout を変更できません。元の結果を確認してください。");
      return this.read(owner, requestId);
    }
    if (this.closed || this.active.size >= 1) unavailable("test_runner_busy", "現在のテスト終了または Cc 復旧後に、同じ request_id で受付を再試行してください。");
    this.db.prepare("INSERT INTO developer_tool_test_jobs(owner,request_id,fingerprint,state,identity_json) VALUES (?,?,?,'running',?)")
      .run(owner, requestId, fingerprint, JSON.stringify(identity));
    // Keep a terminal result even when the HTTP caller disconnects. Shutdown interruption remains running/unknown.
    const key = `${owner}:${requestId}`;
    const pending = Promise.resolve().then(run).then(result => this.finish(owner, requestId, "completed", result),
      error => this.finish(owner, requestId, error instanceof ToolUnavailable && error.reason === "test_execution_outcome_unknown"
        ? "outcome_unknown" : "failed", failure(error))).catch(() => {
      // Storage can be closed during shutdown; the durable running record requires reconciliation.
    }).finally(() => { this.active.delete(key); });
    this.active.set(key, pending);
    return this.read(owner, requestId);
  }
  async close(): Promise<void> { this.closed = true; await Promise.all(this.active.values()); }
  private finish(owner: string, requestId: string, state: string, result: unknown): void {
    this.db.prepare("UPDATE developer_tool_test_jobs SET state=?,result=? WHERE owner=? AND request_id=?")
      .run(state, JSON.stringify(result), owner, requestId);
  }
}
