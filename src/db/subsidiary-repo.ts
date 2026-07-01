/**
 * 子会社 (subsidiary) + 許可 delegation + ロック + 監査ログ の repository。
 *
 * spec/feature/subsidiary-delegation.md §4 が schema の正本。
 * token (bot/app) は secret-box 暗号化済みの値を保存する (平文厳禁)。
 */

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export type SubsidiaryPlatform = "discord" | "slack";

export interface SubsidiaryRow {
  id: string;
  name: string;
  display_name: string;
  description: string;
  platform: SubsidiaryPlatform;
  enabled: number;
  guild_id: string | null;
  application_id: string | null;
  channel_id: string | null;
  bot_token_enc: string | null;
  app_token_enc: string | null;
  guard_model: string;
  guard_scope: string;
  home_cwd: string | null;
  /** 日次トークン予算 (0 = 無制限)。 当日の子会社消費がこれ以上なら受付を止める。 */
  daily_token_budget: number;
  created_at: number;
  updated_at: number;
}

/**
 * 子会社が「所有する」 delegation の複製定義 (1 行 = 1 つの所有 delegation)。
 * グローバル delegation_templates から clone した時点のコピーで、 以降は独立編集可。
 * cwd / project はここで管理する (subsidiary.home_cwd は廃止)。
 */
export interface SubsidiaryDelegationRow {
  subsidiary_id: string;
  call_name: string;
  is_default: number;
  title: string;
  description: string;
  target_provider: string;
  model: string | null;
  prompt_template: string;
  input_schema: string;          // JSON string
  default_cwd: string | null;
  project: string | null;
  emoji: string;
  created_at: number;
  updated_at: number;
}

/** 所有 delegation の作成/更新 input (call_name はキーなので create 専用)。 */
export interface UpsertOwnedDelegationInput {
  call_name: string;
  is_default?: boolean;
  title?: string;
  description?: string;
  target_provider?: string;
  model?: string | null;
  prompt_template?: string;
  input_schema?: string;         // JSON string
  default_cwd?: string | null;
  project?: string | null;
  emoji?: string;
}

export interface SubsidiaryLockRow {
  id: number;
  subsidiary_id: string;
  platform: string;
  platform_user_id: string;
  user_label: string;
  reason: string;
  locked_at: number;
}

export interface SubsidiaryRequestRow {
  id: string;
  subsidiary_id: string;
  platform: string;
  platform_user_id: string;
  user_label: string;
  instruction: string;
  decision: "allow" | "deny";
  reason: string;
  violations_json: string;
  matched_call_name: string | null;
  locked: number;
  run_id: string | null;
  guard_model: string;
  guard_raw: string;
  created_at: number;
}

export interface CreateSubsidiaryInput {
  name: string;
  display_name?: string;
  description?: string;
  platform?: SubsidiaryPlatform;
  enabled?: boolean;
  guild_id?: string | null;
  application_id?: string | null;
  channel_id?: string | null;
  bot_token_enc?: string | null;
  app_token_enc?: string | null;
  guard_model?: string;
  guard_scope?: string;
  daily_token_budget?: number;
}

export interface UpdateSubsidiaryInput {
  display_name?: string;
  description?: string;
  platform?: SubsidiaryPlatform;
  enabled?: boolean;
  guild_id?: string | null;
  application_id?: string | null;
  channel_id?: string | null;
  /** undefined=据え置き / null=クリア / 値=暗号化済み token を保存 */
  bot_token_enc?: string | null;
  app_token_enc?: string | null;
  guard_model?: string;
  guard_scope?: string;
  daily_token_budget?: number;
}

export class SubsidiaryRepo {
  constructor(private readonly db: Database.Database) {}

  // ── subsidiaries ──────────────────────────────────────────

  create(input: CreateSubsidiaryInput): SubsidiaryRow {
    const id = randomUUID();
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO subsidiaries(
        id, name, display_name, description, platform, enabled,
        guild_id, application_id, channel_id, bot_token_enc, app_token_enc,
        guard_model, guard_scope, daily_token_budget, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.name,
      input.display_name ?? "",
      input.description ?? "",
      input.platform ?? "discord",
      input.enabled ? 1 : 0,
      input.guild_id ?? null,
      input.application_id ?? null,
      input.channel_id ?? null,
      input.bot_token_enc ?? null,
      input.app_token_enc ?? null,
      input.guard_model?.trim() || "sonnet",
      input.guard_scope ?? "",
      sanitizeBudget(input.daily_token_budget),
      now,
      now,
    );
    return this.find(id)!;
  }

  update(id: string, patch: UpdateSubsidiaryInput): SubsidiaryRow | null {
    const cur = this.find(id);
    if (!cur) return null;
    this.db.prepare(`
      UPDATE subsidiaries SET
        display_name   = ?,
        description    = ?,
        platform       = ?,
        enabled        = ?,
        guild_id       = ?,
        application_id = ?,
        channel_id     = ?,
        bot_token_enc  = ?,
        app_token_enc  = ?,
        guard_model    = ?,
        guard_scope    = ?,
        daily_token_budget = ?,
        updated_at     = ?
      WHERE id = ?
    `).run(
      patch.display_name ?? cur.display_name,
      patch.description ?? cur.description,
      patch.platform ?? cur.platform,
      patch.enabled === undefined ? cur.enabled : (patch.enabled ? 1 : 0),
      patch.guild_id !== undefined ? patch.guild_id : cur.guild_id,
      patch.application_id !== undefined ? patch.application_id : cur.application_id,
      patch.channel_id !== undefined ? patch.channel_id : cur.channel_id,
      patch.bot_token_enc !== undefined ? patch.bot_token_enc : cur.bot_token_enc,
      patch.app_token_enc !== undefined ? patch.app_token_enc : cur.app_token_enc,
      patch.guard_model?.trim() || cur.guard_model,
      patch.guard_scope ?? cur.guard_scope,
      patch.daily_token_budget !== undefined ? sanitizeBudget(patch.daily_token_budget) : cur.daily_token_budget,
      Date.now(),
      id,
    );
    return this.find(id);
  }

  delete(id: string): boolean {
    const tx = this.db.transaction((sid: string) => {
      this.db.prepare(`DELETE FROM subsidiary_delegations WHERE subsidiary_id = ?`).run(sid);
      this.db.prepare(`DELETE FROM subsidiary_locks WHERE subsidiary_id = ?`).run(sid);
      this.db.prepare(`DELETE FROM subsidiary_requests WHERE subsidiary_id = ?`).run(sid);
      return this.db.prepare(`DELETE FROM subsidiaries WHERE id = ?`).run(sid).changes > 0;
    });
    return tx(id);
  }

  find(id: string): SubsidiaryRow | null {
    return (this.db.prepare(`SELECT * FROM subsidiaries WHERE id = ?`).get(id) as SubsidiaryRow | undefined) ?? null;
  }

  findByName(name: string): SubsidiaryRow | null {
    return (this.db.prepare(`SELECT * FROM subsidiaries WHERE name = ?`).get(name) as SubsidiaryRow | undefined) ?? null;
  }

  list(): SubsidiaryRow[] {
    return this.db.prepare(`SELECT * FROM subsidiaries ORDER BY name ASC`).all() as SubsidiaryRow[];
  }

  listEnabled(): SubsidiaryRow[] {
    return this.db.prepare(`SELECT * FROM subsidiaries WHERE enabled = 1 ORDER BY name ASC`).all() as SubsidiaryRow[];
  }

  // ── 所有 delegation (子会社が複製所有する定義) ──────────────

  listDelegations(subsidiaryId: string): SubsidiaryDelegationRow[] {
    return this.db
      .prepare(`SELECT * FROM subsidiary_delegations WHERE subsidiary_id = ? ORDER BY is_default DESC, call_name ASC`)
      .all(subsidiaryId) as SubsidiaryDelegationRow[];
  }

  findDelegation(subsidiaryId: string, callName: string): SubsidiaryDelegationRow | null {
    return (this.db
      .prepare(`SELECT * FROM subsidiary_delegations WHERE subsidiary_id = ? AND call_name = ?`)
      .get(subsidiaryId, callName) as SubsidiaryDelegationRow | undefined) ?? null;
  }

  /**
   * 所有 delegation を 1 件作成/更新する (call_name がキー)。 既存があれば与えられた
   * フィールドのみ更新 (undefined は据え置き)、 無ければ新規作成する。
   */
  upsertDelegation(subsidiaryId: string, input: UpsertOwnedDelegationInput): SubsidiaryDelegationRow {
    const cur = this.findDelegation(subsidiaryId, input.call_name);
    const now = Date.now();
    if (cur) {
      this.db.prepare(`
        UPDATE subsidiary_delegations SET
          is_default = ?, title = ?, description = ?, target_provider = ?, model = ?,
          prompt_template = ?, input_schema = ?, default_cwd = ?, project = ?, emoji = ?,
          updated_at = ?
        WHERE subsidiary_id = ? AND call_name = ?
      `).run(
        input.is_default === undefined ? cur.is_default : (input.is_default ? 1 : 0),
        input.title ?? cur.title,
        input.description ?? cur.description,
        input.target_provider ?? cur.target_provider,
        input.model !== undefined ? input.model : cur.model,
        input.prompt_template ?? cur.prompt_template,
        input.input_schema ?? cur.input_schema,
        input.default_cwd !== undefined ? input.default_cwd : cur.default_cwd,
        input.project !== undefined ? input.project : cur.project,
        input.emoji ?? cur.emoji,
        now,
        subsidiaryId, input.call_name,
      );
    } else {
      this.db.prepare(`
        INSERT INTO subsidiary_delegations(
          subsidiary_id, call_name, is_default, title, description, target_provider, model,
          prompt_template, input_schema, default_cwd, project, emoji, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        subsidiaryId, input.call_name, input.is_default ? 1 : 0,
        input.title ?? "", input.description ?? "", input.target_provider ?? "claude",
        input.model ?? null, input.prompt_template ?? "", input.input_schema ?? "[]",
        input.default_cwd ?? null, input.project ?? null, input.emoji ?? "", now, now,
      );
    }
    return this.findDelegation(subsidiaryId, input.call_name)!;
  }

  removeDelegation(subsidiaryId: string, callName: string): boolean {
    return this.db
      .prepare(`DELETE FROM subsidiary_delegations WHERE subsidiary_id = ? AND call_name = ?`)
      .run(subsidiaryId, callName).changes > 0;
  }

  /** is_default を 1 件だけ立てる (他は 0 に落とす)。 call_name 不在なら false。 */
  setDefaultDelegation(subsidiaryId: string, callName: string): boolean {
    if (!this.findDelegation(subsidiaryId, callName)) return false;
    const tx = this.db.transaction(() => {
      this.db.prepare(`UPDATE subsidiary_delegations SET is_default = 0 WHERE subsidiary_id = ?`).run(subsidiaryId);
      this.db.prepare(`UPDATE subsidiary_delegations SET is_default = 1 WHERE subsidiary_id = ? AND call_name = ?`)
        .run(subsidiaryId, callName);
    });
    tx();
    return true;
  }

  /** 既定 delegation 行 (is_default=1)。 無ければ最初の 1 件 → null。 */
  defaultDelegation(subsidiaryId: string): SubsidiaryDelegationRow | null {
    const rows = this.listDelegations(subsidiaryId);
    return rows.find((r) => r.is_default === 1) ?? rows[0] ?? null;
  }

  // ── locks ──────────────────────────────────────────────────

  isLocked(subsidiaryId: string, platform: string, platformUserId: string): boolean {
    const row = this.db.prepare(
      `SELECT 1 FROM subsidiary_locks WHERE subsidiary_id = ? AND platform = ? AND platform_user_id = ?`,
    ).get(subsidiaryId, platform, platformUserId);
    return !!row;
  }

  lock(input: {
    subsidiary_id: string;
    platform: string;
    platform_user_id: string;
    user_label?: string;
    reason?: string;
  }): void {
    this.db.prepare(`
      INSERT INTO subsidiary_locks(subsidiary_id, platform, platform_user_id, user_label, reason, locked_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(subsidiary_id, platform, platform_user_id) DO UPDATE SET
        user_label = excluded.user_label,
        reason     = excluded.reason,
        locked_at  = excluded.locked_at
    `).run(
      input.subsidiary_id,
      input.platform,
      input.platform_user_id,
      input.user_label ?? "",
      input.reason ?? "",
      Date.now(),
    );
  }

  unlock(subsidiaryId: string, platform: string, platformUserId: string): boolean {
    return this.db.prepare(
      `DELETE FROM subsidiary_locks WHERE subsidiary_id = ? AND platform = ? AND platform_user_id = ?`,
    ).run(subsidiaryId, platform, platformUserId).changes > 0;
  }

  listLocks(subsidiaryId: string): SubsidiaryLockRow[] {
    return this.db
      .prepare(`SELECT * FROM subsidiary_locks WHERE subsidiary_id = ? ORDER BY locked_at DESC`)
      .all(subsidiaryId) as SubsidiaryLockRow[];
  }

  // ── requests (監査ログ) ────────────────────────────────────

  recordRequest(input: {
    subsidiary_id: string;
    platform: string;
    platform_user_id: string;
    user_label?: string;
    instruction: string;
    decision: "allow" | "deny";
    reason?: string;
    violations?: string[];
    matched_call_name?: string | null;
    locked?: boolean;
    run_id?: string | null;
    guard_model?: string;
    guard_raw?: string;
  }): SubsidiaryRequestRow {
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO subsidiary_requests(
        id, subsidiary_id, platform, platform_user_id, user_label, instruction,
        decision, reason, violations_json, matched_call_name, locked, run_id,
        guard_model, guard_raw, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.subsidiary_id,
      input.platform,
      input.platform_user_id,
      input.user_label ?? "",
      input.instruction,
      input.decision,
      input.reason ?? "",
      JSON.stringify(input.violations ?? []),
      input.matched_call_name ?? null,
      input.locked ? 1 : 0,
      input.run_id ?? null,
      input.guard_model ?? "",
      input.guard_raw ?? "",
      Date.now(),
    );
    return this.db.prepare(`SELECT * FROM subsidiary_requests WHERE id = ?`).get(id) as SubsidiaryRequestRow;
  }

  recentRequests(subsidiaryId: string, limit = 100): SubsidiaryRequestRow[] {
    return this.db
      .prepare(`SELECT * FROM subsidiary_requests WHERE subsidiary_id = ? ORDER BY created_at DESC LIMIT ?`)
      .all(subsidiaryId, limit) as SubsidiaryRequestRow[];
  }

  /**
   * 子会社の受信依頼を decision 別に集計する (sinceMs 以降のみ)。 Monitor の子会社カードで
   * 「直近 N 時間でガードが何件 allow/deny したか」を一目で出すための軽量カウント。
   * created_at は ms (Date.now())。 sinceMs を渡さなければ全期間。
   */
  countRequestsSince(subsidiaryId: string, sinceMs = 0): { allow: number; deny: number } {
    const rows = this.db
      .prepare(
        `SELECT decision, COUNT(*) AS n FROM subsidiary_requests
         WHERE subsidiary_id = ? AND created_at >= ? GROUP BY decision`,
      )
      .all(subsidiaryId, sinceMs) as Array<{ decision: "allow" | "deny"; n: number }>;
    const out = { allow: 0, deny: 0 };
    for (const r of rows) {
      if (r.decision === "allow") out.allow = r.n;
      else if (r.decision === "deny") out.deny = r.n;
    }
    return out;
  }
}

/** 予算値を 0 以上の整数に丸める (負値・NaN・少数は 0 扱いに正規化)。 */
function sanitizeBudget(v: number | undefined): number {
  if (v === undefined || !Number.isFinite(v) || v <= 0) return 0;
  return Math.floor(v);
}
