import { randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import type { CcTaskInput, CcTaskPatch, CcTaskRow, CcTaskSyncState } from "./types.js";

/** @implements spec/feature/cc-task-fallback.md */
export class CcTaskRepository {
  constructor(private readonly db: Database) {}

  create(input: CcTaskInput, now = Date.now()): { task: CcTaskRow; created: boolean } {
    const sourceKey = input.source_key?.trim() || null;
    if (sourceKey) {
      const existing = this.findBySourceKey(sourceKey);
      if (existing) return { task: existing, created: false };
    }
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO cc_tasks(
        id, source_key, title, details, status, kind, creator_type, category, due_at,
        actio_sync_state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      id, sourceKey, input.title.trim(), input.details ?? null, input.status ?? "open",
      input.kind ?? "task", input.creator_type ?? "human", input.category ?? null,
      input.due_at ?? null, now, now,
    );
    return { task: this.find(id)!, created: true };
  }

  find(id: string): CcTaskRow | null {
    return (this.db.prepare("SELECT * FROM cc_tasks WHERE id = ?").get(id) as CcTaskRow | undefined) ?? null;
  }

  findBySourceKey(sourceKey: string): CcTaskRow | null {
    return (this.db.prepare("SELECT * FROM cc_tasks WHERE source_key = ?").get(sourceKey) as CcTaskRow | undefined) ?? null;
  }

  list(input: { status?: string; syncState?: string } = {}): CcTaskRow[] {
    return this.db.prepare(`
      SELECT * FROM cc_tasks
      WHERE (? IS NULL OR status = ?) AND (? IS NULL OR actio_sync_state = ?)
      ORDER BY created_at DESC
    `).all(input.status ?? null, input.status ?? null, input.syncState ?? null, input.syncState ?? null) as CcTaskRow[];
  }

  update(id: string, patch: CcTaskPatch, now = Date.now()): CcTaskRow | null {
    const current = this.find(id);
    if (!current) return null;
    const title = patch.title === undefined ? current.title : patch.title.trim();
    // A POST may have reached Actio while a local PATCH is accepted. Preserve that uncertainty
    // until pluginRef reconciliation; lookup/update work can safely return to pending.
    const hasUnknownCreateOutcome = current.actio_sync_state === "creating"
      || current.actio_sync_state === "unknown";
    const nextSyncState: CcTaskSyncState = hasUnknownCreateOutcome ? "unknown" : "pending";
    const updatedAt = Math.max(now, current.updated_at + 1);
    this.db.prepare(`
      UPDATE cc_tasks SET title = ?, details = ?, status = ?, kind = ?, creator_type = ?,
        category = ?, due_at = ?, actio_sync_state = ?, actio_sync_error = NULL,
        updated_at = ? WHERE id = ?
    `).run(
      title,
      patch.details === undefined ? current.details : patch.details,
      patch.status ?? current.status,
      patch.kind ?? current.kind,
      patch.creator_type ?? current.creator_type,
      patch.category === undefined ? current.category : patch.category,
      patch.due_at === undefined ? current.due_at : patch.due_at,
      nextSyncState,
      updatedAt,
      id,
    );
    return this.find(id);
  }

  nextForSync(): CcTaskRow | null {
    return (this.db.prepare(`
      SELECT * FROM cc_tasks WHERE actio_sync_state IN ('pending', 'unknown')
      ORDER BY CASE actio_sync_state WHEN 'pending' THEN 0 ELSE 1 END, updated_at ASC LIMIT 1
    `).get() as CcTaskRow | undefined) ?? null;
  }

  claim(id: string): boolean {
    return this.db.prepare(`
      UPDATE cc_tasks SET actio_sync_state = 'checking', actio_sync_error = NULL
      WHERE id = ? AND actio_sync_state = 'pending'
    `).run(id).changes === 1;
  }

  beginCreate(id: string): boolean {
    return this.db.prepare(`
      UPDATE cc_tasks SET actio_sync_state = 'creating'
      WHERE id = ? AND actio_sync_state = 'checking'
    `).run(id).changes === 1;
  }

  recoverInterruptedClaims(): number {
    const checking = this.db.prepare(`
      UPDATE cc_tasks SET actio_sync_state = 'pending',
        actio_sync_error = 'Concordia stopped while checking Actio'
      WHERE actio_sync_state = 'checking'
    `).run().changes;
    const creating = this.db.prepare(`
      UPDATE cc_tasks SET actio_sync_state = 'unknown',
        actio_sync_error = 'Concordia stopped while Actio creation outcome was unknown'
      WHERE actio_sync_state = 'creating'
    `).run().changes;
    return checking + creating;
  }

  setSync(
    id: string,
    expectedState: CcTaskSyncState,
    state: CcTaskSyncState,
    input: { actioTaskId?: string | null; error?: string | null; expectedUpdatedAt?: number } = {},
  ): boolean {
    const updatedAt = input.expectedUpdatedAt === undefined
      ? Date.now()
      : Math.max(Date.now(), input.expectedUpdatedAt + 1);
    return this.db.prepare(`
      UPDATE cc_tasks SET actio_task_id = COALESCE(?, actio_task_id), actio_sync_state = ?,
        actio_sync_error = ?, updated_at = ?
      WHERE id = ? AND actio_sync_state = ? AND (? IS NULL OR updated_at = ?)
    `).run(
      input.actioTaskId ?? null,
      state,
      input.error ?? null,
      updatedAt,
      id,
      expectedState,
      input.expectedUpdatedAt ?? null,
      input.expectedUpdatedAt ?? null,
    ).changes === 1;
  }
}
