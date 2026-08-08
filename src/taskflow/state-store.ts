import { relative } from "node:path";
import type Database from "better-sqlite3";
import type { TaskDocument, TaskRuntimeState, TaskStatus } from "./types.js";

export type { TaskRuntimeState } from "./types.js";

type TaskRuntimeRow = Omit<TaskRuntimeState, "memoria_registration_state"> & {
  memoria_registration_state: TaskRuntimeState["memoria_registration_state"];
};

/** Runtime state is intentionally separate from versioned task Markdown. */
export class TaskflowStateStore {
  constructor(private readonly db: Database.Database) {}

  readOrMigrate(document: TaskDocument): TaskRuntimeState {
    const key = taskKey(document);
    const existing = this.db.prepare(`
      SELECT status, source_session, assignee, owner, delegation_run_id, pr_number,
             memoria_task_id, actio_task_id, memoria_registration_state
        FROM taskflow_task_state WHERE repo_path = ? AND task_path = ?
    `).get(key.repoPath, key.taskPath) as TaskRuntimeRow | undefined;
    if (existing) return existing;

    const legacy = legacyRuntime(document.frontmatter);
    this.db.prepare(`
      INSERT INTO taskflow_task_state(
        repo_path, task_path, status, source_session, assignee, owner, delegation_run_id,
        pr_number, memoria_task_id, actio_task_id, memoria_registration_state, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(repo_path, task_path) DO NOTHING
    `).run(
      key.repoPath, key.taskPath, legacy.status, legacy.source_session, legacy.assignee, legacy.owner,
      legacy.delegation_run_id, legacy.pr_number, legacy.memoria_task_id, legacy.actio_task_id,
      legacy.memoria_task_id ? "created" : "idle", Date.now(),
    );
    return this.readOrMigrate(document);
  }

  claimMemoriaCreation(document: TaskDocument): boolean {
    const key = taskKey(document);
    this.readOrMigrate(document);
    const result = this.db.prepare(`
      UPDATE taskflow_task_state
         SET memoria_registration_state = 'creating', updated_at = ?
       WHERE repo_path = ? AND task_path = ?
         AND memoria_task_id IS NULL AND memoria_registration_state = 'idle'
    `).run(Date.now(), key.repoPath, key.taskPath);
    return result.changes === 1;
  }

  recordMemoriaTaskId(document: TaskDocument, id: string | number): void {
    const key = taskKey(document);
    this.db.prepare(`
      UPDATE taskflow_task_state
         SET memoria_task_id = ?, memoria_registration_state = 'created', updated_at = ?
       WHERE repo_path = ? AND task_path = ?
    `).run(String(id), Date.now(), key.repoPath, key.taskPath);
  }
}

function taskKey(document: TaskDocument): { repoPath: string; taskPath: string } {
  return {
    repoPath: normalizePath(document.repoPath),
    taskPath: relative(document.repoPath, document.path).replace(/\\/g, "/"),
  };
}

function legacyRuntime(frontmatter: TaskDocument["frontmatter"]): Omit<TaskRuntimeState, "memoria_registration_state"> {
  return {
    status: taskStatus(frontmatter.status),
    source_session: stringValue(frontmatter.source_session),
    assignee: stringValue(frontmatter.assignee),
    owner: stringValue(frontmatter.owner),
    delegation_run_id: stringValue(frontmatter.delegation_run_id),
    pr_number: positiveInteger(frontmatter.pr_number),
    memoria_task_id: externalId(frontmatter.memoria_task_id),
    actio_task_id: externalId(frontmatter.actio_task_id),
  };
}

function taskStatus(value: unknown): TaskStatus {
  return value === "delegated" || value === "done" || value === "cancelled" ? value : "pending";
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function externalId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : typeof value === "number" ? String(value) : null;
}

function positiveInteger(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  return Number.isInteger(number) && number > 0 ? number : null;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
