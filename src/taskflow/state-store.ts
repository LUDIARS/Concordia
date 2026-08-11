import { relative } from "node:path";
import type Database from "better-sqlite3";
import type { TaskDocument, TaskRuntimeState, TaskStatus } from "./types.js";

export type { TaskRuntimeState } from "./types.js";

type TaskRuntimeRow = Omit<TaskRuntimeState, "memoria_registration_state"> & {
  memoria_registration_state: TaskRuntimeState["memoria_registration_state"];
};

/** Runtime state is intentionally separate from versioned task Markdown. */
export class TaskflowStateStore {
  constructor(
    private readonly db: Database.Database,
    // updated_at は挙動の一部 (再試行の順序判定に使う) なので、 テストから固定できる seam に
    // しておく。 実行時は既定の Date.now をそのまま使う。
    private readonly now: () => number = Date.now,
  ) {}

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
      legacy.memoria_task_id ? "created" : "idle", this.now(),
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
    `).run(this.now(), key.repoPath, key.taskPath);
    return result.changes === 1;
  }

  /**
   * 取得した登録権を返す。 Memoria 登録が失敗したときに呼ぶ。
   *
   * これが無いと、 一度失敗した task は `creating` のまま残り、 以後 `claimMemoriaCreation`
   * が永久に false を返して二度と登録されない (再起動でも直らない — 状態は DB にある)。
   */
  releaseMemoriaCreation(document: TaskDocument): void {
    const key = taskKey(document);
    this.db.prepare(`
      UPDATE taskflow_task_state
         SET memoria_registration_state = 'idle', updated_at = ?
       WHERE repo_path = ? AND task_path = ?
         AND memoria_task_id IS NULL AND memoria_registration_state = 'creating'
    `).run(this.now(), key.repoPath, key.taskPath);
  }

  /**
   * ID の記録は claim を取った側だけが行える。 claim を持たない書き込みを通すと、
   * release 済み (別 tick が取り直した) の task へ古い ID を上書きしてしまう。
   */
  recordMemoriaTaskId(document: TaskDocument, id: string | number): void {
    const key = taskKey(document);
    const result = this.db.prepare(`
      UPDATE taskflow_task_state
         SET memoria_task_id = ?, memoria_registration_state = 'created', updated_at = ?
       WHERE repo_path = ? AND task_path = ?
         AND memoria_registration_state = 'creating'
    `).run(String(id), this.now(), key.repoPath, key.taskPath);
    if (result.changes !== 1) {
      throw new Error(`Memoria task ID cannot be recorded because the claim is not active: ${key.taskPath}`);
    }
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
