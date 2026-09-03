/**
 * Delegation templates + runs repository.
 *
 * spec/delegation.md §2 が schema の正本.
 */

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { applyDelegationProviderPolicy } from "../delegation/provider-policy.js";
import { endDiscordSessionChannels } from "./discord-repo.js";

// 論理 provider プリセット。 claude/codex/gemini は同名 CLI に 1:1。
// gemma4-12 は「ローカル LLM 委託レーン」で、 実体は codex CLI を OSS (Ollama) 経由で
// 起動するが、 推論は OpenAI ではなくローカルモデル (既定 Gemma 4 12B)。 旧名は gamma
// (DB に永続化済みの値は resolveDelegationSpawn が後方互換で受理する)。
// codex-sdk は Satelles のヘッドレスレーン (spec/feature/delegation.md §13.2)。 Lictor /
// wt.exe を経由せず `satelles run|serve` を直接起動する。 effort 系は codex ファミリ扱い
// (src/control/provider-preset.ts:isCodexFamilyProvider)。
// 解決は src/control/provider-preset.ts:resolveDelegationSpawn が単一情報源。
export type DelegationProvider = "claude" | "codex" | "codex-sdk" | "gemini" | "gemma4-12";
export const DELEGATION_PROVIDERS: readonly DelegationProvider[] = ["claude", "codex", "codex-sdk", "gemini", "gemma4-12"];

// Delegation の雇用形態カテゴリ (spec/feature/delegation.md §2)。
//   employee   = 従業員: セッションワーカー。spawn で対話セッションとして起動する汎用実装レーン
//   freelancer = フリーランサー: caller (delegation_invoke / call_only) で呼び出す特化型指示タスク
//   parttimer  = パートタイマー: スケジューラ (cron / morning) が時限起動するタスク
// zod / UI / portable はこの定数を単一情報源として参照する (DELEGATION_PROVIDERS と同パターン)。
export type DelegationCategory = "employee" | "freelancer" | "parttimer" | "test-qa";
export const DELEGATION_CATEGORIES: readonly DelegationCategory[] = ["employee", "freelancer", "parttimer", "test-qa"];
export const DELEGATION_CATEGORY_LABELS: Readonly<Record<DelegationCategory, string>> = {
  employee: "従業員",
  freelancer: "フリーランサー",
  parttimer: "パートタイマー",
  "test-qa": "テスト・QA",
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
  /** 1 = Session forum の spawn-by-post 用タグとして公開する */
  forum_tag: number;
  /**
   * 1 = コードを書かないテンプレ (レビュー / 調査 / 報告)。 成果物が feature branch では
   * ないため、 完了証跡ガード (delegation/completion-evidence.ts) の対象外にする。
   */
  review_only: number;
  /** 雇用形態カテゴリ (employee | freelancer | parttimer)。 既定 employee */
  category: DelegationCategory;
  supervisor_platform?: string | null;
  supervisor_user_id?: string | null;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

export type DelegationTemplateOverrideScopeKind = "platform" | "site";
export interface DelegationTemplateOverrideRow {
  id: string;
  template_id: string;
  scope_kind: DelegationTemplateOverrideScopeKind;
  scope_key: string;
  patch_json: string;
  is_active: number;
  created_at: number;
  updated_at: number;
}

export interface UpsertTemplateOverrideInput {
  template_id: string;
  scope_kind: DelegationTemplateOverrideScopeKind;
  scope_key: string;
  patch_json: string;
  is_active?: boolean;
}

export interface DelegationRunRow {
  id: string;
  template_id: string | null;
  /** 起動時の category snapshot。 null は旧 run / category 不明で、証跡を要求する側に倒す。 */
  category: DelegationCategory | null;
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
  status: "queued" | "launching" | "pending" | "spawned" | "spawn_failed" | "running" | "blocked" | "completed" | "failed";
  error: string | null;
  /** queued の間だけ入る起動入力 (JSON)。 spawn 後は null に落とす。 */
  queue_payload_json: string | null;
  queue_owner?: string | null;
  queue_lease_until?: number | null;
  queue_fencing_token?: number;
  effort_level?: string | null;
  effort_source?: string | null;
  effort_bucket?: string | null;
  effective_model?: string | null;
  fast_mode?: number;
  spawn_cwd?: string | null;
  spawn_branch?: string | null;
  spawn_worktree_path?: string | null;
  spawn_worktree_created?: number;
  effort_decision_id?: number | null;
  finished_at?: number | null;
  team_id?: string | null;
  /** 子会社起点の run 所有者。 null = 本社。 */
  subsidiary_id?: string | null;
  supervisor_platform?: string | null;
  supervisor_user_id?: string | null;
  /** watchdog が最後にこの run を点検した時刻 (epoch-ms)。 */
  watchdog_last_check_at?: number | null;
  /** watchdog が子へ確認 inject を送った回数。 */
  watchdog_nudge_count?: number;
  /** 直近の確認 inject の時刻 (epoch-ms)。 cooldown の根拠。 */
  watchdog_last_nudge_at?: number | null;
  /** 親へのエスカレーション通知を送った時刻 (epoch-ms)。 null = 未送 (1 回きりの保証)。 */
  watchdog_escalated_at?: number | null;
  /** 1 = 段階注入 (初回=調査ブリーフ / 後追い=実装タスク) で起動した run。 */
  staged_injection?: number;
  /** 実装タスク (第2段階) を配信した時刻 (epoch-ms)。 null = 未配信 (1 回きりの保証)。 */
  staged_followup_at?: number | null;
  /** 委託先から届いた調査報告 (証跡)。 */
  investigation_summary?: string | null;
  /** 関連付けた Memoria タスク id。 null = 未作成。 */
  memoria_task_id?: string | null;
  memoria_task_url?: string | null;
  created_at: number;
}

/** spawn 中/実行中とみなす status (= 同時実行スロットを 1 つ占有する)。 */
export const DELEGATION_ACTIVE_STATUSES: readonly DelegationRunRow["status"][] = ["launching", "spawned", "running"];
export const PARTIAL_REQUEUE_CLAIM_ERROR = "partial_requeue_in_progress";
export const REVIEW_ONLY_UNFINISHED_RUN_ERROR = "review_only_locked_by_unfinished_runs";

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
  forum_tag?: boolean;
  review_only?: boolean;
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
  forum_tag?: boolean;
  review_only?: boolean;
  category?: DelegationCategory;
  sort_order?: number;
}

export interface CreateRunInput {
  /** 事前確保された run id。 省略時は repo が UUID を生成する */
  id?: string;
  template_id: string | null;
  /** テンプレートを後から編集・削除しても完了判定が変わらないよう起動時に固定する。 */
  category?: DelegationCategory | null;
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
  effort_level?: string | null;
  effort_source?: string | null;
  effort_bucket?: string | null;
  effective_model?: string | null;
  fast_mode?: boolean;
  spawn_cwd?: string | null;
  spawn_branch?: string | null;
  spawn_worktree_path?: string | null;
  spawn_worktree_created?: boolean;
  effort_decision_id?: number | null;
  finished_at?: number | null;
  team_id?: string | null;
  /** 子会社起点の run 所有者。 null = 本社。 */
  subsidiary_id?: string | null;
  /** 旧: 段階注入で起動したか。 段階注入は 2026-08-21 に廃止 (新規 run は常に false)。 */
  staged_injection?: boolean;
}

/** spawn 試行後に run へ焼き戻す結果 (キュー払い出し時も同じ形)。 */
export interface RunSpawnOutcome {
  status: DelegationRunRow["status"];
  spawn_pid: number | null;
  spawn_command: string[] | null;
  error?: string | null;
  effort_level?: string | null;
  effort_source?: string | null;
  effort_bucket?: string | null;
  effective_model?: string | null;
  fast_mode?: boolean;
  spawn_cwd?: string | null;
  spawn_branch?: string | null;
  spawn_worktree_path?: string | null;
  spawn_worktree_created?: boolean;
  effort_decision_id?: number | null;
  /** queued → spawn の払い出し経路でも段階注入の別を焼き戻す。 */
  staged_injection?: boolean;
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
        forum_tag: input.forum_tag,
        review_only: input.review_only,
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
        emoji, call_only, forum_tag, review_only, category, sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.call_name,
      input.title,
      input.description ?? "",
      applyDelegationProviderPolicy(input.target_provider),
      input.model ?? null,
      JSON.stringify(normalizeRuntimeOptions(input.runtime_options)),
      input.prompt_template,
      JSON.stringify(input.input_schema ?? []),
      input.default_cwd ?? null,
      input.project ?? null,
      input.is_active === false ? 0 : 1,
      input.emoji ?? "",
      input.call_only ? 1 : 0,
      input.forum_tag ? 1 : 0,
      input.review_only ? 1 : 0,
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
    const nextReviewOnly = patch.review_only === undefined ? cur.review_only : (patch.review_only ? 1 : 0);
    if (nextReviewOnly !== cur.review_only && this.hasUnfinishedRunsForTemplate(id)) {
      // completion evidence consults this flag. Letting an in-flight implementation run flip it
      // would allow that run to turn off its own branch-evidence requirement through the API.
      throw new Error(REVIEW_ONLY_UNFINISHED_RUN_ERROR);
    }
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
        forum_tag = ?,
        review_only = ?,
        category = ?,
        sort_order = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      patch.title ?? cur.title,
      patch.description ?? cur.description,
      applyDelegationProviderPolicy(patch.target_provider ?? cur.target_provider),
      patch.model !== undefined ? patch.model : cur.model,
      patch.runtime_options !== undefined ? JSON.stringify(normalizeRuntimeOptions(patch.runtime_options)) : cur.runtime_options_json,
      patch.prompt_template ?? cur.prompt_template,
      patch.input_schema !== undefined ? JSON.stringify(patch.input_schema) : cur.input_schema,
      patch.default_cwd !== undefined ? patch.default_cwd : cur.default_cwd,
      patch.project !== undefined ? patch.project : cur.project,
      patch.is_active === undefined ? cur.is_active : (patch.is_active ? 1 : 0),
      patch.emoji !== undefined ? patch.emoji : cur.emoji,
      patch.call_only !== undefined ? (patch.call_only ? 1 : 0) : cur.call_only,
      patch.forum_tag !== undefined ? (patch.forum_tag ? 1 : 0) : cur.forum_tag,
      patch.review_only !== undefined ? (patch.review_only ? 1 : 0) : cur.review_only,
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

  /**
   * テンプレート定義だけを物理削除し、実行履歴は denormalized call_name と provider で残す。
   * delegation_runs.template_id には FK が無い既存 DB もあるため、先に明示的に NULL 化する。
   */
  deleteTemplatePermanently(id: string): boolean {
    const tx = this.db.transaction(() => {
      this.db.prepare(`UPDATE delegation_runs SET template_id = NULL WHERE template_id = ?`).run(id);
      this.db.prepare(`DELETE FROM delegation_template_overrides WHERE template_id = ?`).run(id);
      return this.db.prepare(`DELETE FROM delegation_templates WHERE id = ?`).run(id).changes > 0;
    });
    return tx();
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

  listTemplateOverrides(templateId?: string): DelegationTemplateOverrideRow[] {
    const sql = templateId
      ? "SELECT * FROM delegation_template_overrides WHERE template_id = ? ORDER BY scope_kind, scope_key"
      : "SELECT * FROM delegation_template_overrides ORDER BY template_id, scope_kind, scope_key";
    return (templateId ? this.db.prepare(sql).all(templateId) : this.db.prepare(sql).all()) as DelegationTemplateOverrideRow[];
  }

  upsertTemplateOverride(input: UpsertTemplateOverrideInput): DelegationTemplateOverrideRow {
    validateTemplateOverrideScope(input.scope_kind, input.scope_key);
    if (!this.findTemplate(input.template_id)) throw new Error("template_not_found");
    const now = Date.now();
    const current = this.db.prepare(
      "SELECT id FROM delegation_template_overrides WHERE template_id = ? AND scope_kind = ? AND scope_key = ?",
    ).get(input.template_id, input.scope_kind, input.scope_key) as { id: string } | undefined;
    if (current) {
      this.db.prepare("UPDATE delegation_template_overrides SET patch_json = ?, is_active = COALESCE(?, is_active), updated_at = ? WHERE id = ?")
        .run(input.patch_json, input.is_active === undefined ? null : input.is_active ? 1 : 0, now, current.id);
      return this.db.prepare("SELECT * FROM delegation_template_overrides WHERE id = ?").get(current.id) as DelegationTemplateOverrideRow;
    }
    const id = randomUUID();
    this.db.prepare(`INSERT INTO delegation_template_overrides (id, template_id, scope_kind, scope_key, patch_json, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.template_id, input.scope_kind, input.scope_key, input.patch_json, input.is_active === false ? 0 : 1, now, now);
    return this.db.prepare("SELECT * FROM delegation_template_overrides WHERE id = ?").get(id) as DelegationTemplateOverrideRow;
  }

  deleteTemplateOverride(id: string): boolean {
    return this.db.prepare("DELETE FROM delegation_template_overrides WHERE id = ?").run(id).changes > 0;
  }

  // ── runs ──────────────────────────────────────────────────

  createRun(input: CreateRunInput): DelegationRunRow {
    const id = input.id ?? randomUUID();
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO delegation_runs(
        id, template_id, category, call_name, target_provider, parent_session_id, child_session_id, args_json,
        rendered_prompt, prompt_file_path, spawn_pid, spawn_command,
        triggered_by, status, error, queue_payload_json, effort_level, effort_source,
        effort_bucket, effective_model, fast_mode, spawn_cwd, spawn_branch,
        spawn_worktree_path, spawn_worktree_created, effort_decision_id, finished_at,
        team_id, subsidiary_id, staged_injection, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.template_id,
      input.category ?? null,
      input.call_name,
      applyDelegationProviderPolicy(input.target_provider),
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
      input.effort_level ?? null,
      input.effort_source ?? null,
      input.effort_bucket ?? null,
      input.effective_model ?? null,
      input.fast_mode ? 1 : 0,
      input.spawn_cwd ?? null,
      input.spawn_branch ?? null,
      input.spawn_worktree_path ?? null,
      input.spawn_worktree_created ? 1 : 0,
      input.effort_decision_id ?? null,
      input.finished_at ?? (isTerminalStatus(input.status) ? now : null),
      input.team_id ?? null,
      input.subsidiary_id ?? null,
      input.staged_injection ? 1 : 0,
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

  /**
   * 子セッション id から最新の run を引く。 委託子セッションの Question を親 (委託元)
   * へリレーするときの親解決に使う (同じ子セッションが複数 run を持つのは再利用時のみで、
   * 現行 run = 最新作成が正)。
   */
  findRunByChildSession(childSessionId: string): DelegationRunRow | null {
    return (this.db.prepare(
      `SELECT * FROM delegation_runs WHERE child_session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ).get(childSessionId) as DelegationRunRow | undefined) ?? null;
  }

  /** spawn 済み / 実行中の run (= 同時実行スロットの候補)。 stale 判定は呼び出し側 (queue.ts)。 */
  listActiveRuns(): DelegationRunRow[] {
    return this.db.prepare(
      `SELECT * FROM delegation_runs WHERE status IN ('launching', 'spawned', 'running') ORDER BY created_at ASC`,
    ).all() as DelegationRunRow[];
  }

  /** review_only is a completion-policy input and must stay stable for every unfinished run. */
  private hasUnfinishedRunsForTemplate(templateId: string): boolean {
    const row = this.db.prepare(
      `SELECT 1 FROM delegation_runs
       WHERE template_id = ? AND status NOT IN ('completed', 'failed')
       LIMIT 1`,
    ).get(templateId);
    return row !== undefined;
  }

  /** Queue capacity also remains occupied while a partial replacement is being launched. */
  listSlotOccupyingRuns(): DelegationRunRow[] {
    return this.db.prepare(
      `SELECT * FROM delegation_runs
       WHERE status IN ('launching', 'spawned', 'running')
          OR (status = 'blocked' AND error = ?)
       ORDER BY created_at ASC`,
    ).all(PARTIAL_REQUEUE_CLAIM_ERROR) as DelegationRunRow[];
  }

  // ── run watchdog の永続状態 (spec/tasks/2026-08-08-delegation-run-watchdog.md) ──

  /** watchdog がこの run を点検した事実だけを記録する (nudge の有無は問わない)。 */
  recordWatchdogCheck(id: string, nowMs: number): void {
    this.db.prepare(`UPDATE delegation_runs SET watchdog_last_check_at = ? WHERE id = ?`).run(nowMs, id);
  }

  /** 子への確認 inject を記録する。 回数と時刻が cooldown / エスカレーション判断の根拠。 */
  recordWatchdogNudge(id: string, nowMs: number, lastActivityMs: number): void {
    this.db.prepare(
      `UPDATE delegation_runs
       SET watchdog_nudge_count = CASE
             WHEN watchdog_last_nudge_at IS NULL OR watchdog_last_nudge_at >= ? THEN watchdog_nudge_count + 1
             ELSE 1
           END,
           watchdog_last_nudge_at = ?, watchdog_last_check_at = ?
       WHERE id = ?`,
    ).run(lastActivityMs, nowMs, nowMs, id);
  }

  /**
   * 親へのエスカレーション通知を記録する。 未送 (null) のときだけ書き込み、 書けたかを
   * 返す — 同一 run への二重通知を DB 側で防ぐ (プロセス再起動をまたいでも 1 回きり)。
   */
  recordWatchdogEscalation(id: string, nowMs: number): boolean {
    const result = this.db.prepare(
      `UPDATE delegation_runs SET watchdog_escalated_at = ?, watchdog_last_check_at = ?
       WHERE id = ? AND watchdog_escalated_at IS NULL`,
    ).run(nowMs, nowMs, id);
    return result.changes > 0;
  }

  // ── 委託 run の追跡タスク / 旧段階注入の残置列 ──
  // 段階注入は 2026-08-21 に廃止 (spec/feature/delegation-implementation-inject.md §1)。
  // `investigation_summary` / `staged_followup_at` / `staged_injection` の各列は既存行の
  // 読み出し (Discord の旧 run 表示など) のためだけに残す。 書き手はもう無いので、
  // 対応する writer (recordInvestigationReport / markStagedFollowupDelivered) は削除した。
  // memoria_task_id だけは現行の起票経路が引き続き使う。

  /**
   * Memoria タスクを run に関連付ける。 未関連 (NULL) のときだけ書き、 書けたかを返す —
   * 同じ run への二重起票を DB 側で防ぐ (プロセス再起動をまたいでも 1 回きり)。
   */
  recordMemoriaTask(id: string, taskId: string, taskUrl: string): boolean {
    const result = this.db.prepare(
      `UPDATE delegation_runs SET memoria_task_id = ?, memoria_task_url = ?
       WHERE id = ? AND memoria_task_id IS NULL`,
    ).run(taskId, taskUrl, id);
    return result.changes > 0;
  }

  /**
   * Atomically claim one launch intent and write its durable outbox record.
   *
   * `activeCount` は呼び出し側 (DelegationQueue) が数えた「今も枠を占有している
   * run の数」。ここで status を生に数えてはいけない — spawn 後にプロセスが落ちて
   * も status は 'running' のまま残るため、死んだ run が枠を食い続けて queued が
   * 二度と払い出されなくなる (2026-07-31 に実発生。実稼働 2 本に対し DB 上 142 本
   * が active 扱いになり、上限 4 を超えて完全に停止した)。占有判定は子セッション
   * の生死を知る queue 側にしか行えないので、判定は一箇所に寄せて値だけ受け取る。
   *
   * その代わり activeCount は transaction の外で数えた値になる。 払い出す drain は
   * workflow worker lease で 1 プロセスに絞られている前提 (bootstrap の producerOnly)
   * なので、 上限は最終的に lease が守る。 spec/feature/delegation-coordination.md §6。
   */
  claimNextQueuedRun(input: {
    owner: string;
    now: number;
    leaseMs: number;
    maxConcurrency: number;
    activeCount: number;
  }): DelegationRunRow | null {
    const claim = this.db.transaction(() => {
      let candidate = this.db.prepare(
        `SELECT id FROM delegation_runs
         WHERE status = 'launching' AND queue_lease_until <= ?
         ORDER BY created_at ASC, rowid ASC LIMIT 1`,
      ).get(input.now) as { id: string } | undefined;

      if (!candidate) {
        if (input.maxConcurrency > 0 && input.activeCount >= input.maxConcurrency) return null;
        candidate = this.db.prepare(
          `SELECT id FROM delegation_runs WHERE status = 'queued'
           ORDER BY created_at ASC, rowid ASC LIMIT 1`,
        ).get() as { id: string } | undefined;
      }
      if (!candidate) return null;

      const updated = this.db.prepare(
        `UPDATE delegation_runs
         SET status = 'launching', queue_owner = ?, queue_lease_until = ?,
             queue_fencing_token = queue_fencing_token + 1
         WHERE id = ? AND (
           status = 'queued' OR (status = 'launching' AND queue_lease_until <= ?)
         )`,
      ).run(input.owner, input.now + input.leaseMs, candidate.id, input.now);
      if (updated.changes !== 1) return null;
      const run = this.findRun(candidate.id)!;
      this.db.prepare(
        `INSERT INTO delegation_outbox(
           run_id, kind, payload_json, status, owner, fencing_token, created_at
         ) VALUES (?, 'launch', ?, 'pending', ?, ?, ?)
         ON CONFLICT(run_id, kind) DO UPDATE SET
           payload_json = excluded.payload_json,
           status = 'pending', owner = excluded.owner,
           fencing_token = excluded.fencing_token, delivered_at = NULL`,
      ).run(
        run.id,
        run.queue_payload_json ?? "{}",
        input.owner,
        run.queue_fencing_token ?? 0,
        input.now,
      );
      return run;
    });
    return claim.immediate();
  }

  /**
   * queued run の spawn 試行結果を焼き戻す。 payload は spawn 後に用済みなので落とす
   * (spawn_failed も再試行しないので落とす — 再実行は新しい run として起こす)。
   */
  markRunSpawned(
    runId: string,
    outcome: RunSpawnOutcome,
    claim?: { owner: string; fencingToken: number },
  ): DelegationRunRow | null {
    const row = this.findRun(runId);
    if (!row) return null;
    if (row.status === "launching" && !claim) return null;
    const complete = this.db.transaction(() => {
      const updated = this.db.prepare(`
      UPDATE delegation_runs
         SET status = ?,
             spawn_pid = ?,
             spawn_command = ?,
             error = ?,
             effort_level = COALESCE(?, effort_level),
             effort_source = COALESCE(?, effort_source),
             effort_bucket = COALESCE(?, effort_bucket),
             effective_model = COALESCE(?, effective_model),
             fast_mode = COALESCE(?, fast_mode),
             spawn_cwd = COALESCE(?, spawn_cwd),
             spawn_branch = COALESCE(?, spawn_branch),
             spawn_worktree_path = COALESCE(?, spawn_worktree_path),
             spawn_worktree_created = COALESCE(?, spawn_worktree_created),
             effort_decision_id = COALESCE(?, effort_decision_id),
             staged_injection = COALESCE(?, staged_injection),
             finished_at = CASE WHEN ? IN ('spawn_failed', 'completed', 'failed') THEN COALESCE(finished_at, ?) ELSE finished_at END,
             queue_payload_json = NULL,
             queue_owner = NULL,
             queue_lease_until = NULL
       WHERE id = ?
         AND (? IS NULL OR (status = 'launching' AND queue_owner = ? AND queue_fencing_token = ?))
    `).run(
      outcome.status,
      outcome.spawn_pid,
      outcome.spawn_command ? JSON.stringify(outcome.spawn_command) : null,
      outcome.error ?? null,
      outcome.effort_level ?? null,
      outcome.effort_source ?? null,
      outcome.effort_bucket ?? null,
      outcome.effective_model ?? null,
      outcome.fast_mode === undefined ? null : (outcome.fast_mode ? 1 : 0),
      outcome.spawn_cwd ?? null,
      outcome.spawn_branch ?? null,
      outcome.spawn_worktree_path ?? null,
      outcome.spawn_worktree_created === undefined ? null : (outcome.spawn_worktree_created ? 1 : 0),
      outcome.effort_decision_id ?? null,
      outcome.staged_injection === undefined ? null : (outcome.staged_injection ? 1 : 0),
      outcome.status,
      Date.now(),
      runId,
      claim?.owner ?? null,
      claim?.owner ?? null,
      claim?.fencingToken ?? null,
    );
      if (updated.changes !== 1) return null;
      if (claim) {
        this.db.prepare(
          `UPDATE delegation_outbox
           SET status = 'delivered', delivered_at = ?
           WHERE run_id = ? AND kind = 'launch' AND owner = ? AND fencing_token = ?`,
        ).run(Date.now(), runId, claim.owner, claim.fencingToken);
      }
      return this.findRun(runId);
    });
    return complete.immediate();
  }

  findRun(id: string): DelegationRunRow | null {
    const row = this.db.prepare(`SELECT * FROM delegation_runs WHERE id = ?`).get(id) as
      | DelegationRunRow
      | undefined;
    return row ?? null;
  }

  findRunByTriggeredBy(triggeredBy: string): DelegationRunRow | null {
    const row = this.db
      .prepare(`SELECT * FROM delegation_runs WHERE triggered_by = ? ORDER BY created_at DESC LIMIT 1`)
      .get(triggeredBy) as DelegationRunRow | undefined;
    return row ?? null;
  }

  /**
   * triggered_by が指定 LIKE パターンのいずれかに一致する run の件数。
   *
   * 「1 case あたり 1 日 N 件まで」のような、起動キーの一部だけが分かっている枠の
   * 判定に使う。プロセス内カウンタでは再起動で消えるため、run 行 (永続) を数える。
   * パターンは呼び出し側が組み立てる。`\` を escape 文字として扱うので、id に `%`
   * や `_` が混ざる場合は呼び出し側で escape すること ({@link escapeLikePattern})。
   */
  countRunsByTriggeredByLike(patterns: readonly string[]): number {
    if (patterns.length === 0) return 0;
    const where = patterns.map(() => `triggered_by LIKE ? ESCAPE '\\'`).join(" OR ");
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM delegation_runs WHERE ${where}`)
      .get(...patterns) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /**
   * Partial report の residual 起動権を原子的に確保する。
   *
   * API 側の read → spawn → update だけでは同時 POST が両方 spawn できるため、
   * source run を一時的に blocked 化して単一 caller だけを通す。queue の launching
   * 状態は queue lease 専用なので流用しない。
   */
  claimPartialRequeue(runId: string): DelegationRunRow | null {
    const updated = this.db.prepare(`
      UPDATE delegation_runs
         SET status = 'blocked', error = ?
       WHERE id = ? AND status IN ('pending', 'spawned', 'running')
    `).run(PARTIAL_REQUEUE_CLAIM_ERROR, runId);
    return updated.changes === 1 ? this.findRun(runId) : null;
  }

  /** residual 起動失敗時だけ claim 前の状態へ戻し、status retry を可能にする。 */
  releasePartialRequeueClaim(
    runId: string,
    previousStatus: DelegationRunRow["status"],
    previousError: string | null,
  ): boolean {
    const updated = this.db.prepare(`
      UPDATE delegation_runs
         SET status = ?, error = ?
       WHERE id = ? AND status = 'blocked' AND error = ?
    `).run(previousStatus, previousError, runId, PARTIAL_REQUEUE_CLAIM_ERROR);
    return updated.changes === 1;
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

  /** A child may have been delegated more than once, so retain every parent link. */
  listRunsByChildSession(childSessionId: string, limit = 100): DelegationRunRow[] {
    return this.db.prepare(
      `SELECT * FROM delegation_runs
       WHERE child_session_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    ).all(childSessionId, limit) as DelegationRunRow[];
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
    const update = this.db.transaction(() => {
      this.db.prepare(`
        UPDATE delegation_runs
           SET status = ?,
               error = ?,
               finished_at = CASE WHEN ? IN ('completed', 'failed') THEN COALESCE(finished_at, ?) ELSE finished_at END
         WHERE id = ?
      `).run(status, error !== undefined ? error : row.error, status, Date.now(), runId);
      if (status === "completed" || status === "failed") {
        const linkedSessions = this.db.prepare(
          `SELECT id FROM sessions
            WHERE json_valid(metadata) AND json_extract(metadata, '$.delegation_run_id') = ?`,
        ).all(runId) as Array<{ id: string }>;
        const sessionIds = new Set(linkedSessions.map((session) => session.id));
        if (row.child_session_id) sessionIds.add(row.child_session_id);
        endDiscordSessionChannels(this.db, [...sessionIds]);
      }
    });
    update();
    return this.findRun(runId);
  }
}

function validateTemplateOverrideScope(kind: DelegationTemplateOverrideScopeKind, key: string): void {
  if (kind !== "platform" && kind !== "site") throw new Error("invalid_override_scope_kind");
  if (!key.trim()) throw new Error("invalid_override_scope_key");
  if (kind === "platform" && key !== "win32" && key !== "darwin") throw new Error("invalid_platform_override_scope_key");
  // Keep site scopes aligned with the authenticated federation site_id shape.
  if (kind === "site" && !/^[a-z0-9][a-z0-9-]{1,63}$/u.test(key)) throw new Error("invalid_site_override_scope_key");
}

function isTerminalStatus(status: DelegationRunRow["status"]): boolean {
  return status === "spawn_failed" || status === "completed" || status === "failed";
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
