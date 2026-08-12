import { isAbsolute, relative, sep } from "node:path";
import type Database from "better-sqlite3";
import { isTaskStatus, type TaskDocument, type TaskRuntimeState, type TaskStatus } from "./types.js";

export type { TaskRuntimeState } from "./types.js";

type TaskRuntimeRow = Omit<TaskRuntimeState, "memoria_registration_state"> & {
  memoria_registration_state: TaskRuntimeState["memoria_registration_state"];
};

/** state 行の同定キー。 repo は絶対パス、 task は repo からの相対パス。 */
export interface TaskStateKey {
  repoPath: string;
  taskPath: string;
}

/** 更新可能な runtime 値。 undefined のフィールドは変更しない。 */
export interface TaskRuntimePatch {
  status?: TaskStatus;
  assignee?: string | null;
  owner?: string | null;
  source_session?: string | null;
  delegation_run_id?: string | null;
  pr_number?: number | null;
}

/**
 * Runtime state is intentionally separate from versioned task Markdown.
 * @implements spec/feature/task-workflow.md — 2.2 登録 (reconcile)
 */
export class TaskflowStateStore {
  constructor(
    private readonly db: Database.Database,
    // updated_at は挙動の一部 (再試行の順序判定に使う) なので、 テストから固定できる seam に
    // しておく。 実行時は既定の Date.now をそのまま使う。
    private readonly now: () => number = Date.now,
  ) {}

  readOrMigrate(document: TaskDocument): TaskRuntimeState {
    const key = taskKey(document);
    const existing = this.read(key);
    if (existing) return existing;

    // rename / 移動で task_path が変わっただけなら、同じリポの同じ slug の行を引き継ぐ。
    // 新規行として扱うと status が失われ、 memoria_registration_state が idle に戻って
    // 同じタスクが Memoria へ二重登録される (旧実装は memoria_task_id が md と一緒に
    // 移動していたので起きなかった後退)。
    const slug = taskSlug(document);
    if (slug && this.rekeyBySlug(key, slug)) {
      const carried = this.read(key);
      if (carried) return carried;
    }

    const legacy = legacyRuntime(document.frontmatter);
    this.db.prepare(`
      INSERT INTO taskflow_task_state(
        repo_path, task_path, task_slug, status, source_session, assignee, owner, delegation_run_id,
        pr_number, memoria_task_id, actio_task_id, memoria_registration_state, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(repo_path, task_path) DO NOTHING
    `).run(
      key.repoPath, key.taskPath, slug, legacy.status, legacy.source_session, legacy.assignee, legacy.owner,
      legacy.delegation_run_id, legacy.pr_number, legacy.memoria_task_id, legacy.actio_task_id,
      legacy.memoria_task_id ? "created" : "idle", this.now(),
    );
    return this.readOrMigrate(document);
  }

  /**
   * runtime state を更新する唯一の書き込み口。
   *
   * md へ status を書き戻さない運用にした結果、 状態を進める手段が移行 INSERT しか
   * 無くなり、 全タスクが移行時点の status に凍結されていた (delegation #797 レビュー High)。
   * done / cancelled へ到達できず、 residual-blackbox が完了済みタスクを再提案し続ける。
   *
   * 渡されなかったフィールドは変更しない。 行が無ければ false。
   */
  update(key: TaskStateKey, patch: TaskRuntimePatch): boolean {
    const columns: string[] = [];
    const values: unknown[] = [];
    for (const [column, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      columns.push(`${column} = ?`);
      values.push(value);
    }
    if (columns.length === 0) return false;
    const result = this.db.prepare(`
      UPDATE taskflow_task_state
         SET ${columns.join(", ")}, updated_at = ?
       WHERE repo_path = ? AND task_path = ?
    `).run(...values, this.now(), normalizePath(key.repoPath), normalizeTaskPath(key.taskPath));
    return result.changes > 0;
  }

  /** 更新後の値を読み直す (API の応答用)。 */
  find(key: TaskStateKey): TaskRuntimeState | null {
    return this.read({ repoPath: normalizePath(key.repoPath), taskPath: normalizeTaskPath(key.taskPath) });
  }

  private read(key: { repoPath: string; taskPath: string }): TaskRuntimeState | null {
    const row = this.db.prepare(`
      SELECT status, source_session, assignee, owner, delegation_run_id, pr_number,
             memoria_task_id, actio_task_id, memoria_registration_state
        FROM taskflow_task_state WHERE repo_path = ? AND task_path = ?
    `).get(key.repoPath, key.taskPath) as TaskRuntimeRow | undefined;
    return row ?? null;
  }

  /**
   * 同じリポで同じ slug の行を新しい task_path へ付け替える。 付け替えたら true。
   *
   * 候補が複数あるときは触らない — どれが移動元か決められない状態で引き継ぐと、
   * 別タスクの memoria_task_id を奪ってしまう。
   */
  private rekeyBySlug(key: { repoPath: string; taskPath: string }, slug: string): boolean {
    const rows = this.db.prepare(`
      SELECT task_path FROM taskflow_task_state WHERE repo_path = ? AND task_slug = ?
    `).all(key.repoPath, slug) as Array<{ task_path: string }>;
    if (rows.length !== 1) return false;
    const from = rows[0]!.task_path;
    if (from === key.taskPath) return false;
    const result = this.db.prepare(`
      UPDATE taskflow_task_state SET task_path = ?, updated_at = ?
       WHERE repo_path = ? AND task_path = ?
    `).run(key.taskPath, this.now(), key.repoPath, from);
    return result.changes > 0;
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
    const normalizedId = externalId(id);
    if (normalizedId === null) throw new Error("Memoria task ID must be a non-empty string or positive integer");
    const result = this.db.prepare(`
      UPDATE taskflow_task_state
         SET memoria_task_id = ?, memoria_registration_state = 'created', updated_at = ?
       WHERE repo_path = ? AND task_path = ?
         AND memoria_task_id IS NULL AND memoria_registration_state = 'creating'
    `).run(normalizedId, this.now(), key.repoPath, key.taskPath);
    if (result.changes !== 1) {
      throw new Error(`Memoria task ID cannot be recorded because the claim is not active: ${key.taskPath}`);
    }
  }
}

function taskKey(document: TaskDocument): { repoPath: string; taskPath: string } {
  const taskPath = relative(document.repoPath, document.path);
  if (taskPath === "" || isAbsolute(taskPath) || taskPath === ".." || taskPath.startsWith(`..${sep}`)) {
    throw new Error("task path must be inside its repository");
  }
  return {
    repoPath: normalizePath(document.repoPath),
    taskPath: normalizeTaskPath(taskPath),
  };
}

function normalizeTaskPath(value: string): string {
  return value.replace(/\\/g, "/");
}

/** rename 追跡のキー。 frontmatter の task (slug) が無い md は追跡しない。 */
function taskSlug(document: TaskDocument): string | null {
  const value = document.frontmatter.task;
  return typeof value === "string" && value.trim() ? value.trim() : null;
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
  if (value === undefined || value === null) return "pending";
  if (isTaskStatus(value)) return value;
  throw new Error("legacy task status is invalid");
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function externalId(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? String(value) : null;
}

function positiveInteger(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
