/**
 * Runtime-toggled admin switches that previously lived as one-shot env
 * vars (CONCORDIA_DISABLE_CLAUDE) or were unreachable without a restart.
 *
 *   - chat_muted               default true   — chitchat / chat-reply / report
 *                                                 task enqueues are skipped
 *   - rules_enabled            default false  — rule engine 発火を停止
 *   - workspace_root           default cfg    — ローカルクローン親 (Memoria 解決 /
 *                                                 reaction-workflow / Work 走査の基点)
 *   - github_org               default cfg    — リポが属する GitHub Organization
 *                                                 (PR / repo 操作 owner 解決)
 *
 * workspace_root / github_org は値が未設定のとき constructor 既定 (config 由来) に
 * フォールバックする。 GUI / API から上書きすると schema_meta に永続化され、
 * 次回の Discord/Slack bot start (= restart) で実効値として反映される。
 *
 * Persisted in `schema_meta` (key/value table that already exists). All
 * reads cache the row to one SELECT per get — cheap enough for the rule
 * engine's per-tick check.
 *
 * The env var CONCORDIA_DISABLE_CLAUDE=1 still wins as an emergency OFF
 * even when rules_enabled=true in DB — see callers.
 */

import type Database from "better-sqlite3";

const KEY_CHAT_MUTED = "admin.chat_muted";
const KEY_RULES_ENABLED = "admin.rules_enabled";
const KEY_WORKSPACE_ROOT = "admin.workspace_root";
const KEY_WORKSPACE_ROOTS = "admin.workspace_roots";
const KEY_GITHUB_ORG = "admin.github_org";
const KEY_REACTION_WORKFLOW = "admin.reaction_workflow_enabled";
const KEY_REACTION_MAPPINGS = "admin.reaction_emoji_overrides";
const KEY_LICTOR_MODE = "admin.lictor_mode";
const KEY_LICTOR_DEV_PATH = "admin.lictor_dev_path";
const KEY_LICTOR_PROD_EXE = "admin.lictor_prod_exe";
const KEY_DAILY_TOKEN_BUDGET = "admin.daily_token_budget";

/** Lictor 起動モード。 auto = 従来どおり PATH 上の `lictor` を起動。 */
export type LictorMode = "auto" | "dev" | "prod";
const LICTOR_MODES: readonly LictorMode[] = ["auto", "dev", "prod"];

const DEFAULT_CHAT_MUTED = true;
const DEFAULT_RULES_ENABLED = false;

/** workspace_root / github_org / reaction_workflow の未設定時フォールバック (config / env 由来)。 */
export interface AdminStateDefaults {
  workspaceRoot?: string;
  /** 複数ワークスペースルート既定 (config.workspaceRoots 由来)。 先頭がプライマリ。 */
  workspaceRoots?: string[];
  githubOrg?: string;
  /** 既定の reaction-workflow ON/OFF (env CONCORDIA_REACTION_WORKFLOW 由来)。 */
  reactionWorkflowEnabled?: boolean;
  /** Lictor dev モードのローカルリポ既定パス (例 <workspaceRoot>/Lictor)。 */
  lictorDevPath?: string;
}

export class AdminState {
  constructor(
    private readonly db: Database.Database,
    private readonly defaults: AdminStateDefaults = {},
  ) {}

  getChatMuted(): boolean {
    return this.getBool(KEY_CHAT_MUTED, DEFAULT_CHAT_MUTED);
  }

  setChatMuted(value: boolean): void {
    this.setBool(KEY_CHAT_MUTED, value);
  }

  getRulesEnabled(): boolean {
    return this.getBool(KEY_RULES_ENABLED, DEFAULT_RULES_ENABLED);
  }

  setRulesEnabled(value: boolean): void {
    this.setBool(KEY_RULES_ENABLED, value);
  }

  /**
   * 走査対象のワークスペースルート群 (reaction-workflow / Work 走査の基点)。
   * 解決順: array key (新) → 旧 single key (移行用) → config 既定。
   * 返り値は trim + 空除去 + 正規化重複除去済。
   */
  getWorkspaceRoots(): string[] {
    const rawArray = this.getRaw(KEY_WORKSPACE_ROOTS);
    if (rawArray !== null) {
      const parsed = parseRootsJson(rawArray);
      const cleaned = cleanRoots(parsed);
      if (cleaned.length > 0) return cleaned;
    }
    // 旧 single key (新 UI で保存する前の DB) からの移行フォールバック。
    const single = this.getRaw(KEY_WORKSPACE_ROOT);
    if (single !== null && single.trim() !== "") return [single.trim()];
    return cleanRoots(this.defaults.workspaceRoots ?? (this.defaults.workspaceRoot ? [this.defaults.workspaceRoot] : []));
  }

  /** プライマリ (先頭) ルート。 単一ルート前提の消費者 (Lictor 等) 用。 未設定なら ""。 */
  getWorkspaceRoot(): string {
    return this.getWorkspaceRoots()[0] ?? "";
  }

  /** 複数ルートを一括設定 (JSON 配列で永続化)。 trim + 空除去 + 重複除去して保存。 */
  setWorkspaceRoots(values: string[]): void {
    this.setRaw(KEY_WORKSPACE_ROOTS, JSON.stringify(cleanRoots(values)));
  }

  /** 単一ルート設定 (後方互換)。 array key を [value] で上書きする。 */
  setWorkspaceRoot(value: string): void {
    this.setWorkspaceRoots(value.trim() ? [value.trim()] : []);
  }

  /** リポが属する GitHub Organization (例 "LUDIARS")。 未設定なら config 既定。 */
  getGithubOrg(): string {
    const raw = this.getRaw(KEY_GITHUB_ORG);
    if (raw !== null && raw.trim() !== "") return raw;
    return this.defaults.githubOrg ?? "";
  }

  setGithubOrg(value: string): void {
    this.setRaw(KEY_GITHUB_ORG, value.trim());
  }

  /** リアクションワークフローの安全弁 (ON/OFF)。 未設定なら env 由来の constructor 既定。 */
  getReactionWorkflowEnabled(): boolean {
    return this.getBool(KEY_REACTION_WORKFLOW, this.defaults.reactionWorkflowEnabled ?? false);
  }

  setReactionWorkflowEnabled(value: boolean): void {
    this.setBool(KEY_REACTION_WORKFLOW, value);
  }

  // ── リアクション 絵文字→アクション 上書き写像 ─────────────────────────
  // 既定写像 (reaction-workflow.ts WORKFLOW_EMOJI) に上書きする emoji→action の辞書。
  // action 値の妥当性検証は API 層 (isWorkflowAction) で行い、 ここは素の文字列辞書。

  /** ユーザ設定の 絵文字→アクション 上書き辞書 (空なら {})。 */
  getReactionEmojiOverrides(): Record<string, string> {
    const raw = this.getRaw(KEY_REACTION_MAPPINGS);
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, string>;
      }
    } catch {
      // 壊れた値は無視 (空辞書扱い)。
    }
    return {};
  }

  /** 1 件 upsert (emoji→action)。 */
  setReactionEmojiOverride(emoji: string, action: string): void {
    const e = emoji.trim();
    if (!e) return;
    const cur = this.getReactionEmojiOverrides();
    cur[e] = action;
    this.setRaw(KEY_REACTION_MAPPINGS, JSON.stringify(cur));
  }

  /** 1 件削除 (既定写像に戻す)。 */
  deleteReactionEmojiOverride(emoji: string): void {
    const cur = this.getReactionEmojiOverrides();
    if (!Object.prototype.hasOwnProperty.call(cur, emoji.trim())) return;
    delete cur[emoji.trim()];
    this.setRaw(KEY_REACTION_MAPPINGS, JSON.stringify(cur));
  }

  // ── Lictor 起動設定 (spawn の launcher 解決に使う) ─────────────────────

  getLictorMode(): LictorMode {
    const raw = this.getRaw(KEY_LICTOR_MODE);
    return (LICTOR_MODES as string[]).includes(raw ?? "") ? (raw as LictorMode) : "auto";
  }

  setLictorMode(value: string): void {
    if (!(LICTOR_MODES as string[]).includes(value)) {
      throw new Error(`lictor_mode must be one of ${LICTOR_MODES.join(" / ")}`);
    }
    this.setRaw(KEY_LICTOR_MODE, value);
  }

  /** dev モードのローカル Lictor リポ。 未設定なら constructor 既定。 */
  getLictorDevPath(): string {
    const raw = this.getRaw(KEY_LICTOR_DEV_PATH);
    if (raw !== null && raw.trim() !== "") return raw;
    return this.defaults.lictorDevPath ?? "";
  }

  setLictorDevPath(value: string): void {
    this.setRaw(KEY_LICTOR_DEV_PATH, value.trim());
  }

  /** prod モードの同梱 Lictor exe のパス (Release 公開物)。 */
  getLictorProdExe(): string {
    return this.getRaw(KEY_LICTOR_PROD_EXE) ?? "";
  }

  setLictorProdExe(value: string): void {
    this.setRaw(KEY_LICTOR_PROD_EXE, value.trim());
  }

  // ── コスト予算 (日次トークン上限) ────────────────────────────────────
  // 0 = 無効 (ブロックしない)。 1 以上 = その日のトークン消費合計が上限に
  // 達したら Concordia 発の命令 (spawn / dispatcher / リアクションWF / proposer)
  // を止める。 外部バッチのトークンも CostUsageTracker 経由で計上される。

  /** 日次トークン予算 (0 = 無効)。 未設定なら 0。 */
  getDailyTokenBudget(): number {
    const raw = this.getRaw(KEY_DAILY_TOKEN_BUDGET);
    if (raw === null) return 0;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  setDailyTokenBudget(value: number): void {
    if (!Number.isFinite(value)) {
      throw new Error("daily_token_budget must be a finite number");
    }
    this.setRaw(KEY_DAILY_TOKEN_BUDGET, String(Math.max(0, Math.floor(value))));
  }

  snapshot(): {
    chat_muted: boolean;
    rules_enabled: boolean;
    workspace_root: string;
    workspace_roots: string[];
    github_org: string;
    reaction_workflow_enabled: boolean;
    lictor_mode: LictorMode;
    lictor_dev_path: string;
    lictor_prod_exe: string;
    daily_token_budget: number;
  } {
    return {
      chat_muted: this.getChatMuted(),
      rules_enabled: this.getRulesEnabled(),
      workspace_root: this.getWorkspaceRoot(),
      workspace_roots: this.getWorkspaceRoots(),
      github_org: this.getGithubOrg(),
      reaction_workflow_enabled: this.getReactionWorkflowEnabled(),
      lictor_mode: this.getLictorMode(),
      lictor_dev_path: this.getLictorDevPath(),
      lictor_prod_exe: this.getLictorProdExe(),
      daily_token_budget: this.getDailyTokenBudget(),
    };
  }

  // ── internals ───────────────────────────────────────────────────────

  private getRaw(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM schema_meta WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  private setRaw(key: string, value: string): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, ?)`)
      .run(key, value);
  }

  private getBool(key: string, fallback: boolean): boolean {
    const raw = this.getRaw(key);
    if (raw === null) return fallback;
    return raw === "1" || raw === "true";
  }

  private setBool(key: string, value: boolean): void {
    this.setRaw(key, value ? "1" : "0");
  }
}

/** schema_meta に入った JSON 配列文字列を string[] に復元 (壊れた値は [])。 */
function parseRootsJson(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    // 壊れた値は無視。
  }
  return [];
}

/** trim + 空除去 + 正規化パスで重複除去 (先頭優先) (pure)。 */
function cleanRoots(roots: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of roots) {
    const t = r.trim();
    if (!t) continue;
    const key = t.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}
