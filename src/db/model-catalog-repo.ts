/**
 * Model catalog repository.
 *
 * delegation テンプレ / spawn の `--model` に渡せるモデル候補を「手動更新できる
 * 選択肢」として管理する。 値は頻繁に変わる (新モデル登場 / 旧モデル廃止) ため
 * コード直書きを避け、 Web UI (Settings) から CRUD する。
 *
 * spec/delegation.md §6 が schema の正本。
 */

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

/** model 候補が紐づく provider。 'any' は全 provider 共通候補。 gemma4-12 = ローカル LLM レーン (旧名 gamma)。 */
export type ModelProvider = "any" | "claude" | "codex" | "gemini" | "gemma4-12";
export const MODEL_PROVIDERS: readonly ModelProvider[] = ["any", "claude", "codex", "gemini", "gemma4-12"];

export function isModelProvider(v: unknown): v is ModelProvider {
  return typeof v === "string" && (MODEL_PROVIDERS as readonly string[]).includes(v);
}

export interface ModelCatalogRow {
  id: string;
  model_id: string;
  label: string;
  provider: ModelProvider;
  sort_order: number;
  is_active: number;
  created_at: number;
  updated_at: number;
}

export interface CreateModelInput {
  model_id: string;
  label?: string;
  provider?: ModelProvider;
  sort_order?: number;
  is_active?: boolean;
}

export interface UpdateModelInput {
  model_id?: string;
  label?: string;
  provider?: ModelProvider;
  sort_order?: number;
  is_active?: boolean;
}

export class ModelCatalogRepo {
  constructor(private readonly db: Database.Database) {}

  create(input: CreateModelInput): ModelCatalogRow {
    const id = randomUUID();
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO model_catalog(
        id, model_id, label, provider, sort_order, is_active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.model_id,
      input.label ?? "",
      input.provider ?? "any",
      input.sort_order ?? 0,
      input.is_active === false ? 0 : 1,
      now,
      now,
    );
    return this.find(id)!;
  }

  /** provider+model_id の組で 1 行を upsert (seed / 冪等投入用)。 */
  upsert(input: CreateModelInput): ModelCatalogRow {
    const provider = input.provider ?? "any";
    const existing = this.db
      .prepare(`SELECT * FROM model_catalog WHERE provider = ? AND model_id = ?`)
      .get(provider, input.model_id) as ModelCatalogRow | undefined;
    if (existing) {
      return this.update(existing.id, input) ?? existing;
    }
    return this.create(input);
  }

  update(id: string, patch: UpdateModelInput): ModelCatalogRow | null {
    const cur = this.find(id);
    if (!cur) return null;
    const now = Date.now();
    this.db.prepare(`
      UPDATE model_catalog SET
        model_id = ?,
        label = ?,
        provider = ?,
        sort_order = ?,
        is_active = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      patch.model_id ?? cur.model_id,
      patch.label !== undefined ? patch.label : cur.label,
      patch.provider ?? cur.provider,
      patch.sort_order !== undefined ? patch.sort_order : cur.sort_order,
      patch.is_active === undefined ? cur.is_active : (patch.is_active ? 1 : 0),
      now,
      id,
    );
    return this.find(id);
  }

  remove(id: string): boolean {
    const r = this.db.prepare(`DELETE FROM model_catalog WHERE id = ?`).run(id);
    return r.changes > 0;
  }

  find(id: string): ModelCatalogRow | null {
    const row = this.db.prepare(`SELECT * FROM model_catalog WHERE id = ?`).get(id) as
      | ModelCatalogRow
      | undefined;
    return row ?? null;
  }

  list(options: { includeInactive?: boolean } = {}): ModelCatalogRow[] {
    const sql = options.includeInactive
      ? `SELECT * FROM model_catalog ORDER BY sort_order ASC, model_id ASC`
      : `SELECT * FROM model_catalog WHERE is_active = 1 ORDER BY sort_order ASC, model_id ASC`;
    return this.db.prepare(sql).all() as ModelCatalogRow[];
  }
}
