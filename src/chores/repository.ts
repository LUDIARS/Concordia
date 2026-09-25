import type { Database } from "better-sqlite3";
import type { Chore, ChoreStatus } from "./domain.js";

/** Owns the durable chore ledger; every transition is compare-and-swap. */
export class ChoresRepository {
  constructor(private readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS chore_runs (
      id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, prompt TEXT NOT NULL,
      provider TEXT NOT NULL, status TEXT NOT NULL, cwd TEXT NOT NULL,
      output TEXT NOT NULL DEFAULT '', error TEXT, spawn_id TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1, delivered_revision INTEGER NOT NULL DEFAULT 0,
      discord_message_id TEXT
    ); CREATE INDEX IF NOT EXISTS chore_runs_status ON chore_runs(status, created_at);`);
  }
  find(id: string): Chore | null {
    return this.db.prepare("SELECT * FROM chore_runs WHERE id = ?").get(id) as Chore | undefined ?? null;
  }
  byRequest(key: string): Chore | null {
    return this.db.prepare("SELECT * FROM chore_runs WHERE request_key = ?").get(key) as Chore | undefined ?? null;
  }
  list(): Chore[] {
    return this.db.prepare("SELECT * FROM chore_runs ORDER BY created_at DESC, id DESC LIMIT 100").all() as Chore[];
  }
  undelivered(): Chore[] {
    return this.db.prepare("SELECT * FROM chore_runs WHERE status NOT IN ('queued','running') AND delivered_revision < revision ORDER BY created_at LIMIT 50").all() as Chore[];
  }
  enqueue(row: Chore): Chore {
    return this.db.transaction(() => {
      const existing = this.byRequest(row.request_key);
      if (existing) {
        if (existing.prompt !== row.prompt || existing.provider !== row.provider) throw new Error("受付キーが別の依頼で使用されています。");
        return existing;
      }
      const count = this.db.prepare("SELECT count(*) AS n FROM chore_runs WHERE status IN ('queued','running')").get() as { n: number };
      if (count.n >= 20) throw new Error("雑務の待ち行列が満杯です。");
      this.db.prepare(`INSERT INTO chore_runs (id,request_key,prompt,provider,status,cwd,created_at,updated_at)
        VALUES (@id,@request_key,@prompt,@provider,@status,@cwd,@created_at,@updated_at)`).run(row);
      return row;
    })();
  }
  claim(now: number): Chore | null {
    return this.db.transaction(() => {
      // A different/previous process may still own an execution. Never replay it.
      if (this.db.prepare("SELECT 1 FROM chore_runs WHERE status = 'running' LIMIT 1").get()) return null;
      const row = this.db.prepare("SELECT * FROM chore_runs WHERE status = 'queued' ORDER BY created_at, id LIMIT 1").get() as Chore | undefined;
      if (!row) return null;
      return this.transition(row, "running", now);
    })();
  }
  transition(row: Chore, status: ChoreStatus, now: number, fields: { output?: string; error?: string | null; spawn_id?: string | null } = {}): Chore | null {
    const next = { ...row, ...fields, status, updated_at: now };
    const result = this.db.prepare(`UPDATE chore_runs SET status=@status, output=@output, error=@error,
      spawn_id=@spawn_id, updated_at=@updated_at, revision=revision+1 WHERE id=@id AND revision=@revision`).run(next);
    return result.changes === 1 ? this.find(row.id) : null;
  }
  expireBefore(deadline: number, now: number): void {
    this.db.prepare(`UPDATE chore_runs SET status='interrupted', error='実行結果が不明です。作業ディレクトリと残存プロセスを確認してください。',
      updated_at=?, revision=revision+1 WHERE status='running' AND updated_at < ?`).run(now, deadline);
  }
  delivered(id: string, revision: number, messageId: string): void {
    this.db.prepare(`UPDATE chore_runs SET discord_message_id=?, delivered_revision=max(delivered_revision, ?)
      WHERE id=? AND revision>=?`).run(messageId, revision, id, revision);
  }
}
