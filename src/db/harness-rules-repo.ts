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
}

export interface CreateHarnessRuleInput {
  kind: HarnessRuleKind;
  title?: string;
  description: string;
  enabled?: boolean;
  builtin?: boolean;
  sort_order?: number;
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
      INSERT INTO harness_rules(id, kind, title, description, enabled, builtin, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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

  list(options: { includeDisabled?: boolean } = {}): HarnessRuleRow[] {
    const sql = options.includeDisabled
      ? `SELECT * FROM harness_rules ORDER BY sort_order ASC, created_at ASC`
      : `SELECT * FROM harness_rules WHERE enabled = 1 ORDER BY sort_order ASC, created_at ASC`;
    return this.db.prepare(sql).all() as HarnessRuleRow[];
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
