/**
 * Delegation templates + runs repository.
 *
 * spec/delegation.md §2 が schema の正本.
 */

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

// 論理 provider プリセット。 claude/codex/gemini は同名 CLI に 1:1。
// gemma4-12 は「ローカル LLM 委託レーン」で、 実体は codex CLI を OSS (Ollama) 経由で
// 起動するが、 推論は OpenAI ではなくローカルモデル (既定 Gemma 4 12B)。 旧名は gamma
// (DB に永続化済みの値は resolveDelegationSpawn が後方互換で受理する)。
// 解決は src/control/provider-preset.ts:resolveDelegationSpawn が単一情報源。
export type DelegationProvider = "claude" | "codex" | "gemini" | "gemma4-12";
export const DELEGATION_PROVIDERS: readonly DelegationProvider[] = ["claude", "codex", "gemini", "gemma4-12"];

export interface DelegationTemplateRow {
  id: string;
  call_name: string;
  title: string;
  description: string;
  target_provider: DelegationProvider;
  /** spawn する CLI に `--model` で渡す値。 null = provider CLI の config 既定に委ねる */
  model: string | null;
  prompt_template: string;
  input_schema: string;          // JSON string
  default_cwd: string | null;
  /** 対象プロジェクト名 (cwd と別に delegation が持つ。 famulus auto-model のヒント等)。 */
  project: string | null;
  is_active: number;
  /** チャット表示用絵文字。 空文字 = モデル/provider フォールバック */
  emoji: string;
  /** 1 = LLM 委託専用テンプレ。 Discord/Slack の spawn ドロップダウンに出さない */
  call_only: number;
  created_at: number;
  updated_at: number;
}

export interface DelegationRunRow {
  id: string;
  template_id: string | null;
  call_name: string;
  target_provider: DelegationProvider;
  args_json: string;
  rendered_prompt: string;
  prompt_file_path: string;
  spawn_pid: number | null;
  spawn_command: string | null;   // JSON array
  triggered_by: string | null;
  status: "pending" | "spawned" | "spawn_failed";
  error: string | null;
  created_at: number;
}

export interface InputSchemaItem {
  name: string;
  type: "string" | "number" | "boolean";
  required: boolean;
  description?: string;
  default?: string | number | boolean;
}

export interface CreateTemplateInput {
  call_name: string;
  title: string;
  description?: string;
  target_provider: DelegationProvider;
  model?: string | null;
  prompt_template: string;
  input_schema?: InputSchemaItem[];
  default_cwd?: string | null;
  project?: string | null;
  is_active?: boolean;
  emoji?: string;
  call_only?: boolean;
}

export interface UpdateTemplateInput {
  title?: string;
  description?: string;
  target_provider?: DelegationProvider;
  model?: string | null;
  prompt_template?: string;
  input_schema?: InputSchemaItem[];
  default_cwd?: string | null;
  project?: string | null;
  is_active?: boolean;
  emoji?: string;
  call_only?: boolean;
}

export interface CreateRunInput {
  /** 事前確保された run id。 省略時は repo が UUID を生成する */
  id?: string;
  template_id: string | null;
  call_name: string;
  target_provider: DelegationProvider;
  args: Record<string, unknown>;
  rendered_prompt: string;
  prompt_file_path: string;
  spawn_pid: number | null;
  spawn_command: string[] | null;
  triggered_by: string | null;
  status: DelegationRunRow["status"];
  error?: string | null;
}

export class DelegationRepo {
  constructor(private readonly db: Database.Database) {}

  // ── templates ─────────────────────────────────────────────

  upsertTemplate(input: CreateTemplateInput): DelegationTemplateRow {
    const existing = this.findTemplateByCallName(input.call_name);
    if (existing) {
      return this.updateTemplate(existing.id, {
        title: input.title,
        description: input.description,
        target_provider: input.target_provider,
        model: input.model,
        prompt_template: input.prompt_template,
        input_schema: input.input_schema,
        default_cwd: input.default_cwd,
        project: input.project,
        is_active: input.is_active,
        emoji: input.emoji,
        call_only: input.call_only,
      }) ?? existing;
    }
    return this.createTemplate(input);
  }

  createTemplate(input: CreateTemplateInput): DelegationTemplateRow {
    const id = randomUUID();
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO delegation_templates(
        id, call_name, title, description, target_provider, model,
        prompt_template, input_schema, default_cwd, project, is_active,
        emoji, call_only, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.call_name,
      input.title,
      input.description ?? "",
      input.target_provider,
      input.model ?? null,
      input.prompt_template,
      JSON.stringify(input.input_schema ?? []),
      input.default_cwd ?? null,
      input.project ?? null,
      input.is_active === false ? 0 : 1,
      input.emoji ?? "",
      input.call_only ? 1 : 0,
      now,
      now,
    );
    return this.findTemplate(id)!;
  }

  updateTemplate(id: string, patch: UpdateTemplateInput): DelegationTemplateRow | null {
    const cur = this.findTemplate(id);
    if (!cur) return null;
    const now = Date.now();
    this.db.prepare(`
      UPDATE delegation_templates SET
        title = ?,
        description = ?,
        target_provider = ?,
        model = ?,
        prompt_template = ?,
        input_schema = ?,
        default_cwd = ?,
        project = ?,
        is_active = ?,
        emoji = ?,
        call_only = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      patch.title ?? cur.title,
      patch.description ?? cur.description,
      patch.target_provider ?? cur.target_provider,
      patch.model !== undefined ? patch.model : cur.model,
      patch.prompt_template ?? cur.prompt_template,
      patch.input_schema !== undefined ? JSON.stringify(patch.input_schema) : cur.input_schema,
      patch.default_cwd !== undefined ? patch.default_cwd : cur.default_cwd,
      patch.project !== undefined ? patch.project : cur.project,
      patch.is_active === undefined ? cur.is_active : (patch.is_active ? 1 : 0),
      patch.emoji !== undefined ? patch.emoji : cur.emoji,
      patch.call_only !== undefined ? (patch.call_only ? 1 : 0) : cur.call_only,
      now,
      id,
    );
    return this.findTemplate(id);
  }

  deactivateTemplate(id: string): boolean {
    const r = this.db.prepare(
      `UPDATE delegation_templates SET is_active = 0, updated_at = ? WHERE id = ?`,
    ).run(Date.now(), id);
    return r.changes > 0;
  }

  findTemplate(id: string): DelegationTemplateRow | null {
    const row = this.db.prepare(`SELECT * FROM delegation_templates WHERE id = ?`).get(id) as
      | DelegationTemplateRow
      | undefined;
    return row ?? null;
  }

  findTemplateByCallName(call_name: string): DelegationTemplateRow | null {
    const row = this.db
      .prepare(`SELECT * FROM delegation_templates WHERE call_name = ?`)
      .get(call_name) as DelegationTemplateRow | undefined;
    return row ?? null;
  }

  listTemplates(options: { includeInactive?: boolean } = {}): DelegationTemplateRow[] {
    const sql = options.includeInactive
      ? `SELECT * FROM delegation_templates ORDER BY call_name ASC`
      : `SELECT * FROM delegation_templates WHERE is_active = 1 ORDER BY call_name ASC`;
    return this.db.prepare(sql).all() as DelegationTemplateRow[];
  }

  // ── runs ──────────────────────────────────────────────────

  createRun(input: CreateRunInput): DelegationRunRow {
    const id = input.id ?? randomUUID();
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO delegation_runs(
        id, template_id, call_name, target_provider, args_json,
        rendered_prompt, prompt_file_path, spawn_pid, spawn_command,
        triggered_by, status, error, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.template_id,
      input.call_name,
      input.target_provider,
      JSON.stringify(input.args ?? {}),
      input.rendered_prompt,
      input.prompt_file_path,
      input.spawn_pid,
      input.spawn_command ? JSON.stringify(input.spawn_command) : null,
      input.triggered_by,
      input.status,
      input.error ?? null,
      now,
    );
    return this.findRun(id)!;
  }

  findRun(id: string): DelegationRunRow | null {
    const row = this.db.prepare(`SELECT * FROM delegation_runs WHERE id = ?`).get(id) as
      | DelegationRunRow
      | undefined;
    return row ?? null;
  }

  recentRuns(limit = 100): DelegationRunRow[] {
    return this.db.prepare(
      `SELECT * FROM delegation_runs ORDER BY created_at DESC LIMIT ?`,
    ).all(limit) as DelegationRunRow[];
  }
}

export function parseInputSchema(json: string): InputSchemaItem[] {
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is InputSchemaItem =>
      x && typeof x === "object" &&
      typeof x.name === "string" &&
      ["string", "number", "boolean"].includes(x.type),
    );
  } catch {
    return [];
  }
}
