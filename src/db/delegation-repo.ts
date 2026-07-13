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

// Delegation の雇用形態カテゴリ (spec/feature/delegation.md §2)。
//   employee   = 従業員: セッションワーカー。spawn で対話セッションとして起動する汎用実装レーン
//   freelancer = フリーランサー: caller (delegation_invoke / call_only) で呼び出す特化型指示タスク
//   parttimer  = パートタイマー: スケジューラ (cron / morning) が時限起動するタスク
// zod / UI / portable はこの定数を単一情報源として参照する (DELEGATION_PROVIDERS と同パターン)。
export type DelegationCategory = "employee" | "freelancer" | "parttimer";
export const DELEGATION_CATEGORIES: readonly DelegationCategory[] = ["employee", "freelancer", "parttimer"];
export const DELEGATION_CATEGORY_LABELS: Readonly<Record<DelegationCategory, string>> = {
  employee: "従業員",
  freelancer: "フリーランサー",
  parttimer: "パートタイマー",
};
export const DEFAULT_DELEGATION_CATEGORY: DelegationCategory = "employee";

export interface DelegationTemplateRow {
  id: string;
  call_name: string;
  title: string;
  description: string;
  target_provider: DelegationProvider;
  /** spawn する CLI に `--model` で渡す値。 null = provider CLI の config 既定に委ねる */
  model: string | null;
  runtime_options_json: string;
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
  /** 雇用形態カテゴリ (employee | freelancer | parttimer)。 既定 employee */
  category: DelegationCategory;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

export interface DelegationRunRow {
  id: string;
  template_id: string | null;
  call_name: string;
  target_provider: DelegationProvider;
  parent_session_id: string | null;
  child_session_id: string | null;
  args_json: string;
  rendered_prompt: string;
  prompt_file_path: string;
  spawn_pid: number | null;
  spawn_command: string | null;   // JSON array
  triggered_by: string | null;
  /**
   * queued = 同時実行上限に達していたため spawn を保留した状態 (queue_payload_json に
   * 起動入力一式を持ち、 スロットが空き次第 FIFO で spawn される)。
   */
  status: "queued" | "pending" | "spawned" | "spawn_failed" | "running" | "completed" | "failed";
  error: string | null;
  /** queued の間だけ入る起動入力 (JSON)。 spawn 後は null に落とす。 */
  queue_payload_json: string | null;
  created_at: number;
}

/** spawn 中/実行中とみなす status (= 同時実行スロットを 1 つ占有する)。 */
export const DELEGATION_ACTIVE_STATUSES: readonly DelegationRunRow["status"][] = ["spawned", "running"];

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
  runtime_options?: Record<string, unknown>;
  prompt_template: string;
  input_schema?: InputSchemaItem[];
  default_cwd?: string | null;
  project?: string | null;
  is_active?: boolean;
  emoji?: string;
  call_only?: boolean;
  category?: DelegationCategory;
  sort_order?: number;
}

export interface UpdateTemplateInput {
  title?: string;
  description?: string;
  target_provider?: DelegationProvider;
  model?: string | null;
  runtime_options?: Record<string, unknown>;
  prompt_template?: string;
  input_schema?: InputSchemaItem[];
  default_cwd?: string | null;
  project?: string | null;
  is_active?: boolean;
  emoji?: string;
  call_only?: boolean;
  category?: DelegationCategory;
  sort_order?: number;
}

export interface CreateRunInput {
  /** 事前確保された run id。 省略時は repo が UUID を生成する */
  id?: string;
  template_id: string | null;
  call_name: string;
  target_provider: DelegationProvider;
  parent_session_id?: string | null;
  child_session_id?: string | null;
  args: Record<string, unknown>;
  rendered_prompt: string;
  prompt_file_path: string;
  spawn_pid: number | null;
  spawn_command: string[] | null;
  triggered_by: string | null;
  status: DelegationRunRow["status"];
  error?: string | null;
  /** status='queued' で作るときの起動入力 (JSON)。 */
  queue_payload_json?: string | null;
}

/** spawn 試行後に run へ焼き戻す結果 (キュー払い出し時も同じ形)。 */
export interface RunSpawnOutcome {
  status: DelegationRunRow["status"];
  spawn_pid: number | null;
  spawn_command: string[] | null;
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
        runtime_options: input.runtime_options,
        prompt_template: input.prompt_template,
        input_schema: input.input_schema,
        default_cwd: input.default_cwd,
        project: input.project,
        is_active: input.is_active,
        emoji: input.emoji,
        call_only: input.call_only,
        category: input.category,
        sort_order: input.sort_order,
      }) ?? existing;
    }
    return this.createTemplate(input);
  }

  createTemplate(input: CreateTemplateInput): DelegationTemplateRow {
    const id = randomUUID();
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO delegation_templates(
        id, call_name, title, description, target_provider, model, runtime_options_json,
        prompt_template, input_schema, default_cwd, project, is_active,
        emoji, call_only, category, sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.call_name,
      input.title,
      input.description ?? "",
      input.target_provider,
      input.model ?? null,
      JSON.stringify(normalizeRuntimeOptions(input.runtime_options)),
      input.prompt_template,
      JSON.stringify(input.input_schema ?? []),
      input.default_cwd ?? null,
      input.project ?? null,
      input.is_active === false ? 0 : 1,
      input.emoji ?? "",
      input.call_only ? 1 : 0,
      input.category ?? DEFAULT_DELEGATION_CATEGORY,
      input.sort_order ?? 1000,
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
        runtime_options_json = ?,
        prompt_template = ?,
        input_schema = ?,
        default_cwd = ?,
        project = ?,
        is_active = ?,
        emoji = ?,
        call_only = ?,
        category = ?,
        sort_order = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      patch.title ?? cur.title,
      patch.description ?? cur.description,
      patch.target_provider ?? cur.target_provider,
      patch.model !== undefined ? patch.model : cur.model,
      patch.runtime_options !== undefined ? JSON.stringify(normalizeRuntimeOptions(patch.runtime_options)) : cur.runtime_options_json,
      patch.prompt_template ?? cur.prompt_template,
      patch.input_schema !== undefined ? JSON.stringify(patch.input_schema) : cur.input_schema,
      patch.default_cwd !== undefined ? patch.default_cwd : cur.default_cwd,
      patch.project !== undefined ? patch.project : cur.project,
      patch.is_active === undefined ? cur.is_active : (patch.is_active ? 1 : 0),
      patch.emoji !== undefined ? patch.emoji : cur.emoji,
      patch.call_only !== undefined ? (patch.call_only ? 1 : 0) : cur.call_only,
      patch.category !== undefined ? patch.category : cur.category,
      patch.sort_order !== undefined ? patch.sort_order : cur.sort_order,
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
      ? `SELECT * FROM delegation_templates ORDER BY sort_order ASC, call_name ASC`
      : `SELECT * FROM delegation_templates WHERE is_active = 1 ORDER BY sort_order ASC, call_name ASC`;
    return this.db.prepare(sql).all() as DelegationTemplateRow[];
  }

  // ── runs ──────────────────────────────────────────────────

  createRun(input: CreateRunInput): DelegationRunRow {
    const id = input.id ?? randomUUID();
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO delegation_runs(
        id, template_id, call_name, target_provider, parent_session_id, child_session_id, args_json,
        rendered_prompt, prompt_file_path, spawn_pid, spawn_command,
        triggered_by, status, error, queue_payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.template_id,
      input.call_name,
      input.target_provider,
      input.parent_session_id ?? null,
      input.child_session_id ?? null,
      JSON.stringify(input.args ?? {}),
      input.rendered_prompt,
      input.prompt_file_path,
      input.spawn_pid,
      input.spawn_command ? JSON.stringify(input.spawn_command) : null,
      input.triggered_by,
      input.status,
      input.error ?? null,
      input.queue_payload_json ?? null,
      now,
    );
    return this.findRun(id)!;
  }

  // ── 実行キュー ────────────────────────────────────────────

  /**
   * 待機中 (queued) の run を投入順 (FIFO) に返す。 created_at は ms なので同一 ms に
   * 複数投入されうる (キューが効くのは高負荷時 = まさに同時投入時) 。 その並びが UUID 順に
   * なって追い越しが起きないよう、 同時刻は挿入順 (rowid) で解く。
   */
  listQueuedRuns(limit = 200): DelegationRunRow[] {
    return this.db.prepare(
      `SELECT * FROM delegation_runs WHERE status = 'queued' ORDER BY created_at ASC, rowid ASC LIMIT ?`,
    ).all(limit) as DelegationRunRow[];
  }

  /** spawn 済み / 実行中の run (= 同時実行スロットの候補)。 stale 判定は呼び出し側 (queue.ts)。 */
  listActiveRuns(): DelegationRunRow[] {
    return this.db.prepare(
      `SELECT * FROM delegation_runs WHERE status IN ('spawned', 'running') ORDER BY created_at ASC`,
    ).all() as DelegationRunRow[];
  }

  /**
   * queued run の spawn 試行結果を焼き戻す。 payload は spawn 後に用済みなので落とす
   * (spawn_failed も再試行しないので落とす — 再実行は新しい run として起こす)。
   */
  markRunSpawned(runId: string, outcome: RunSpawnOutcome): DelegationRunRow | null {
    const row = this.findRun(runId);
    if (!row) return null;
    this.db.prepare(`
      UPDATE delegation_runs
         SET status = ?,
             spawn_pid = ?,
             spawn_command = ?,
             error = ?,
             queue_payload_json = NULL
       WHERE id = ?
    `).run(
      outcome.status,
      outcome.spawn_pid,
      outcome.spawn_command ? JSON.stringify(outcome.spawn_command) : null,
      outcome.error ?? null,
      runId,
    );
    return this.findRun(runId);
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

  listRunsByParentSession(parentSessionId: string, limit = 100): DelegationRunRow[] {
    return this.db.prepare(
      `SELECT * FROM delegation_runs
       WHERE parent_session_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    ).all(parentSessionId, limit) as DelegationRunRow[];
  }

  claimChildSession(runId: string, childSessionId: string): DelegationRunRow | null {
    const nowStatus = this.findRun(runId)?.status;
    if (!nowStatus) return null;
    this.db.prepare(`
      UPDATE delegation_runs
         SET child_session_id = COALESCE(child_session_id, ?),
             status = CASE
               WHEN status IN ('pending', 'spawned') THEN 'running'
               ELSE status
             END
       WHERE id = ?
    `).run(childSessionId, runId);
    return this.findRun(runId);
  }

  updateRunStatus(
    runId: string,
    status: DelegationRunRow["status"],
    error?: string | null,
  ): DelegationRunRow | null {
    const row = this.findRun(runId);
    if (!row) return null;
    this.db.prepare(`
      UPDATE delegation_runs
         SET status = ?,
             error = ?
       WHERE id = ?
    `).run(status, error !== undefined ? error : row.error, runId);
    return this.findRun(runId);
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

export function parseRuntimeOptions(json: string | null | undefined): Record<string, unknown> {
  if (!json) return {};
  try {
    return normalizeRuntimeOptions(JSON.parse(json));
  } catch {
    return {};
  }
}

function normalizeRuntimeOptions(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
