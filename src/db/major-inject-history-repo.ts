import type Database from "better-sqlite3";

export interface InjectHistoryVersion {
  version_id: number;
  target_id: string;
  parent_version_id: number | null;
  revision: string;
  content: string;
  actor: string;
  change_kind: string;
  created_at: number;
  operation_id: string | null;
}

export interface InjectFileOperation {
  operation_id: string;
  target_id: string;
  parent_version_id: number;
  expected_revision: string;
  desired_revision: string;
  content: string;
  actor: string;
  change_kind: string;
  created_at: number;
  status: "pending" | "applied" | "failed" | "uncertain" | "resolved";
  failure_reason: string | null;
}

/** Append-only effective versions and a separate recoverable file-operation journal. */
export class MajorInjectHistoryRepo {
  constructor(private readonly db: Database.Database) {}

  latest(targetId: string): InjectHistoryVersion | null {
    return this.db.prepare(`SELECT * FROM major_inject_history WHERE target_id = ? ORDER BY version_id DESC LIMIT 1`)
      .get(targetId) as InjectHistoryVersion | null ?? null;
  }

  version(targetId: string, versionId: number): InjectHistoryVersion | null {
    return this.db.prepare(`SELECT * FROM major_inject_history WHERE target_id = ? AND version_id = ?`)
      .get(targetId, versionId) as InjectHistoryVersion | null ?? null;
  }

  list(targetId: string, before: number | null, limit: number): InjectHistoryVersion[] {
    return this.db.prepare(`SELECT * FROM major_inject_history WHERE target_id = ? AND (? IS NULL OR version_id < ?)
      ORDER BY version_id DESC LIMIT ?`).all(targetId, before, before, limit) as InjectHistoryVersion[];
  }

  append(input: Omit<InjectHistoryVersion, "version_id">): InjectHistoryVersion {
    const id = this.db.prepare(`INSERT INTO major_inject_history
      (target_id, parent_version_id, revision, content, actor, change_kind, created_at, operation_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(input.target_id, input.parent_version_id, input.revision,
      input.content, input.actor, input.change_kind, input.created_at, input.operation_id).lastInsertRowid;
    return this.version(input.target_id, Number(id))!;
  }

  ensureBaseline(targetId: string, content: string, revision: string): InjectHistoryVersion {
    return this.latest(targetId) ?? this.append({ target_id: targetId, parent_version_id: null,
      revision, content, actor: "unknown", change_kind: "baseline", created_at: Date.now(), operation_id: null });
  }

  pending(targetId: string): InjectFileOperation | null {
    return this.db.prepare(`SELECT * FROM major_inject_file_ops WHERE target_id = ? AND status IN ('pending', 'uncertain')
      ORDER BY created_at DESC LIMIT 1`).get(targetId) as InjectFileOperation | null ?? null;
  }

  operation(operationId: string): InjectFileOperation | null {
    return this.db.prepare(`SELECT * FROM major_inject_file_ops WHERE operation_id = ?`)
      .get(operationId) as InjectFileOperation | null ?? null;
  }

  addOperation(input: Omit<InjectFileOperation, "status" | "failure_reason">): void {
    this.db.prepare(`INSERT INTO major_inject_file_ops
      (operation_id, target_id, parent_version_id, expected_revision, desired_revision, content, actor,
       change_kind, created_at, status, failure_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL)`)
      .run(input.operation_id, input.target_id, input.parent_version_id, input.expected_revision,
        input.desired_revision, input.content, input.actor, input.change_kind, input.created_at);
  }

  setOperationStatus(operationId: string, status: InjectFileOperation["status"], reason: string | null = null): void {
    this.db.prepare(`UPDATE major_inject_file_ops SET status = ?, failure_reason = ? WHERE operation_id = ?`)
      .run(status, reason, operationId);
  }

  transaction<T>(work: () => T): T { return this.db.transaction(work)(); }
}
