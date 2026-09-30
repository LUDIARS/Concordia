/**
 * 部署 (departments) の repository。 保存と照会だけを持ち、 所有・範囲の判断は
 * src/departments/ の純関数とユースケースが行う。
 *
 * @implements spec/feature/departments.md §4
 * @implements SPEC-DEPT-STORE
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { DepartmentSettings } from "../departments/settings.js";

export interface DepartmentRow {
  id: string;
  /** 所有する子会社。 NULL は本社部署。 作成後は変えない (CC-DEPT-INV-01)。 */
  subsidiary_id: string | null;
  name: string;
  slug: string;
  description: string;
  settings_json: string;
  rules_text: string;
  sort_order: number;
  /** 部署のセッションが何をするか (spec/feature/dialogue-context.md)。 NULL = 未設定。 */
  use_case_id: string | null;
  /** 会社の既定部署なら 1 (会社ごとに 1 つまで)。 */
  is_default: number;
  /** 部署フォーラムの channel id。 既定部署は Session フォーラムを使うので NULL。 */
  discord_forum_id: string | null;
  /** 廃止した時刻 (epoch-ms)。 NULL = 稼働中。 */
  archived_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface DepartmentCreateInput {
  subsidiary_id: string | null;
  name: string;
  slug: string;
  description?: string;
  settings: DepartmentSettings;
  rules_text?: string;
  sort_order?: number;
  use_case_id?: string | null;
}

export interface DepartmentPatchInput {
  name?: string;
  slug?: string;
  description?: string;
  settings?: DepartmentSettings;
  rules_text?: string;
  sort_order?: number;
  use_case_id?: string | null;
}

const ORDER = "ORDER BY sort_order ASC, name ASC, id ASC";

export class DepartmentsRepo {
  constructor(private readonly db: Database.Database) {}

  /** 本社 (null) または指定子会社が所有する部署。 */
  listForOrganization(subsidiaryId: string | null, options: { includeArchived?: boolean } = {}): DepartmentRow[] {
    const archived = options.includeArchived ? "" : "AND archived_at IS NULL";
    return this.db.prepare(
      `SELECT * FROM departments WHERE subsidiary_id IS ? ${archived} ${ORDER}`,
    ).all(subsidiaryId) as DepartmentRow[];
  }

  /** 全会社の部署。 組織セッション画面が会社カードごとに振り分ける。 */
  listAll(options: { includeArchived?: boolean } = {}): DepartmentRow[] {
    const archived = options.includeArchived ? "" : "WHERE archived_at IS NULL";
    return this.db.prepare(`SELECT * FROM departments ${archived} ${ORDER}`).all() as DepartmentRow[];
  }

  find(id: string): DepartmentRow | null {
    return (this.db.prepare("SELECT * FROM departments WHERE id = ?").get(id) as DepartmentRow | undefined) ?? null;
  }

  /** 会社の既定部署 (稼働中のものだけ)。 */
  findDefault(subsidiaryId: string | null): DepartmentRow | null {
    return (this.db.prepare(
      "SELECT * FROM departments WHERE subsidiary_id IS ? AND is_default = 1 AND archived_at IS NULL",
    ).get(subsidiaryId) as DepartmentRow | undefined) ?? null;
  }

  /** 部署フォーラムの channel id から部署を引く (投稿からの起動の入口)。 */
  findByForumId(forumId: string): DepartmentRow | null {
    if (!forumId) return null;
    return (this.db.prepare("SELECT * FROM departments WHERE discord_forum_id = ?").get(forumId) as DepartmentRow | undefined) ?? null;
  }

  /** slug は会社ごとに一意。 本社と子会社で同じ slug を使える。 */
  findBySlug(subsidiaryId: string | null, slug: string): DepartmentRow | null {
    return (this.db.prepare(
      "SELECT * FROM departments WHERE subsidiary_id IS ? AND slug = ?",
    ).get(subsidiaryId, slug) as DepartmentRow | undefined) ?? null;
  }

  create(input: DepartmentCreateInput, now: number = Date.now()): DepartmentRow {
    const id = `dept_${randomUUID().replace(/-/g, "")}`;
    this.db.prepare(`
      INSERT INTO departments(
        id, subsidiary_id, name, slug, description, settings_json, rules_text,
        sort_order, use_case_id, archived_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
    `).run(
      id,
      input.subsidiary_id,
      input.name,
      input.slug,
      input.description ?? "",
      JSON.stringify(input.settings),
      input.rules_text ?? "",
      input.sort_order ?? 0,
      input.use_case_id ?? null,
      now,
      now,
    );
    return this.find(id)!;
  }

  patch(id: string, input: DepartmentPatchInput, now: number = Date.now()): DepartmentRow | null {
    const row = this.find(id);
    if (!row) return null;
    this.db.prepare(`
      UPDATE departments
      SET name = ?, slug = ?, description = ?, settings_json = ?, rules_text = ?, sort_order = ?,
          use_case_id = ?, updated_at = ?
      WHERE id = ?
    `).run(
      input.name ?? row.name,
      input.slug ?? row.slug,
      input.description ?? row.description,
      input.settings === undefined ? row.settings_json : JSON.stringify(input.settings),
      input.rules_text ?? row.rules_text,
      input.sort_order ?? row.sort_order,
      input.use_case_id === undefined ? row.use_case_id : input.use_case_id,
      now,
      id,
    );
    return this.find(id);
  }

  /**
   * 既定部署を切り替える。 同じ会社の他の既定を外してから立てる (1 トランザクション)。
   * isDefault=false はこの部署の既定だけを外す。
   */
  setDefault(id: string, isDefault: boolean, now: number = Date.now()): DepartmentRow | null {
    const row = this.find(id);
    if (!row) return null;
    const apply = this.db.transaction(() => {
      if (isDefault) {
        this.db.prepare("UPDATE departments SET is_default = 0, updated_at = ? WHERE subsidiary_id IS ? AND is_default = 1 AND id <> ?")
          .run(now, row.subsidiary_id, id);
      }
      this.db.prepare("UPDATE departments SET is_default = ?, updated_at = ? WHERE id = ?").run(isDefault ? 1 : 0, now, id);
    });
    apply.immediate();
    return this.find(id);
  }

  /** 部署フォーラムの channel id を記録する (Bot の用意結果)。 */
  setDiscordForum(id: string, forumId: string | null, now: number = Date.now()): void {
    this.db.prepare("UPDATE departments SET discord_forum_id = ?, updated_at = ? WHERE id = ?").run(forumId, now, id);
  }

  /** 廃止 / 復帰。 既に同じ状態なら何もしない (冪等)。 部署が無ければ null。 */
  setArchived(id: string, archived: boolean, now: number = Date.now()): DepartmentRow | null {
    const row = this.find(id);
    if (!row) return null;
    if ((row.archived_at !== null) === archived) return row;
    // 廃止した部署は既定から外す。 廃止済みの既定部署が残ると、 部署未指定の起動が
    // 全部「廃止済み」で止まる。
    this.db.prepare("UPDATE departments SET archived_at = ?, is_default = CASE WHEN ? THEN 0 ELSE is_default END, updated_at = ? WHERE id = ?")
      .run(archived ? now : null, archived ? 1 : 0, now, id);
    return this.find(id);
  }
}
