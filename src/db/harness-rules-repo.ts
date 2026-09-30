/**
 * 共通ハーネスルール repository。 子会社ガード (Sonnet) が参照するポリシーを
 * Concordia ダッシュボードから設定する。 spec/feature/subsidiary-delegation.md §2.2。
 *
 * builtin=1 の既定ルールは無効化 (enabled=0) はできるが削除はできない。
 */

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export type HarnessRuleKind = "allow" | "block";

export interface HarnessRuleRow {
  id: string;
  kind: HarnessRuleKind;
  title: string;
  description: string;
  enabled: number;
  builtin: number;
  sort_order: number;
  created_at: number;
  updated_at: number;
  team_id: string | null;
  /** 部署スコープ (spec/feature/departments.md §6)。 NULL = 部署に絞らない。 team_id と排他。 */
  department_id?: string | null;
}

export interface CreateHarnessRuleInput {
  kind: HarnessRuleKind;
  title?: string;
  description: string;
  enabled?: boolean;
  builtin?: boolean;
  sort_order?: number;
  team_id?: string | null;
  department_id?: string | null;
}

export interface UpdateHarnessRuleInput {
  kind?: HarnessRuleKind;
  title?: string;
  description?: string;
  enabled?: boolean;
  sort_order?: number;
}

export class HarnessRulesRepo {
  constructor(private readonly db: Database.Database) {}

  create(input: CreateHarnessRuleInput): HarnessRuleRow {
    const id = randomUUID();
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO harness_rules(id, kind, title, description, enabled, builtin, sort_order, created_at, updated_at, team_id, department_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.kind,
      input.title ?? "",
      input.description,
      input.enabled === false ? 0 : 1,
      input.builtin ? 1 : 0,
      input.sort_order ?? 0,
      now,
      now,
      input.team_id ?? null,
      input.department_id ?? null,
    );
    return this.find(id)!;
  }

  update(id: string, patch: UpdateHarnessRuleInput): HarnessRuleRow | null {
    const cur = this.find(id);
    if (!cur) return null;
    this.db.prepare(`
      UPDATE harness_rules SET
        kind = ?, title = ?, description = ?, enabled = ?, sort_order = ?, updated_at = ?
      WHERE id = ?
    `).run(
      patch.kind ?? cur.kind,
      patch.title ?? cur.title,
      patch.description ?? cur.description,
      patch.enabled === undefined ? cur.enabled : (patch.enabled ? 1 : 0),
      patch.sort_order ?? cur.sort_order,
      Date.now(),
      id,
    );
    return this.find(id);
  }

  /** builtin は削除不可 (enabled=0 で無効化させる)。 削除できたら true。 */
  remove(id: string): { ok: boolean; reason?: string } {
    const cur = this.find(id);
    if (!cur) return { ok: false, reason: "not_found" };
    if (cur.builtin === 1) return { ok: false, reason: "builtin_cannot_delete" };
    this.db.prepare(`DELETE FROM harness_rules WHERE id = ?`).run(id);
    return { ok: true };
  }

  find(id: string): HarnessRuleRow | null {
    return (this.db.prepare(`SELECT * FROM harness_rules WHERE id = ?`).get(id) as HarnessRuleRow | undefined) ?? null;
  }

  /**
   * 部署スコープの行は、 departmentId を渡したときはその部署の分だけ、 includeAllScopes の
   * ときは全部署分を含める。 どちらも無い既定の一覧 (子会社ガード等) には入れない —
   * ある部署の作業方針が別会社のガード判定へ混ざらないようにする (departments.md §6)。
   */
  list(options: { includeDisabled?: boolean; teamId?: string; departmentId?: string; includeAllScopes?: boolean } = {}): HarnessRuleRow[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (!options.includeDisabled) where.push("enabled = 1");
    // team scope: グローバル (team_id NULL) + 当該チームのルールを併せて返す (§3.2 のマージ規則)。
    if (options.teamId) { where.push("(team_id IS NULL OR team_id = ?)"); args.push(options.teamId); }
    if (options.departmentId) { where.push("(department_id IS NULL OR department_id = ?)"); args.push(options.departmentId); }
    else if (!options.includeAllScopes) where.push("department_id IS NULL");
    const sql = `SELECT * FROM harness_rules ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY sort_order ASC, created_at ASC`;
    return this.db.prepare(sql).all(...args) as HarnessRuleRow[];
  }
  listForTeam(teamId: string | null): HarnessRuleRow[] { return this.db.prepare("SELECT * FROM harness_rules WHERE enabled=1 AND department_id IS NULL AND (team_id IS NULL OR team_id=?) ORDER BY sort_order,created_at").all(teamId) as HarnessRuleRow[]; }

  /**
   * セッションの着手前ルール供給用: 全体 + 当該部署 + 当該チームの有効な行。
   * 並べ替え (全体 → 部署 → チーム) は departments/rule-layers.ts が行う。
   */
  listForScope(scope: { teamId: string | null; departmentId: string | null }): HarnessRuleRow[] {
    return this.db.prepare(`
      SELECT * FROM harness_rules
      WHERE enabled = 1
        AND ((team_id IS NULL AND department_id IS NULL) OR team_id = ? OR (team_id IS NULL AND department_id = ?))
      ORDER BY sort_order, created_at
    `).all(scope.teamId, scope.departmentId) as HarnessRuleRow[];
  }

  /** builtin の既定ルールが (title 一致で) 無ければ作る。 既存は description を上書きしない。 */
  ensureBuiltin(input: Required<Pick<CreateHarnessRuleInput, "kind" | "title" | "description">> & { sort_order: number }): void {
    const existing = this.db.prepare(`SELECT id FROM harness_rules WHERE builtin = 1 AND title = ?`).get(input.title) as
      | { id: string }
      | undefined;
    if (existing) return;
    this.create({ ...input, builtin: true, enabled: true });
  }
}
