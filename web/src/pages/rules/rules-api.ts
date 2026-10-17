// 巡回チャット / rule 画面の API client (spec/feature/patrol-chat.md §9)。
// 422 / 409 の理由を画面に出したいので、 共通 api.ts の「status だけ投げる」helper ではなく本文ごと返す。

export type ExecutionMode = "legacy-observe" | "patrol";

export interface FollowupConfig {
  reply_enabled: boolean;
  reaction_threshold: number;
  later_message_threshold: number;
  min_wait_sec: number;
  window_sec: number;
  max_unprompted: number;
  max_replies: number;
}

export interface PatrolActionConfig {
  kind: "material-chat";
  source_ids: string[];
  scope_key: string;
  filters: {
    genres?: string[];
    service_codes?: string[];
    feature_keys?: string[];
    event_kinds?: string[];
    max_age_sec: number;
  };
  renderer: "oneshot" | "template";
  /**
   * 以下 4 項目は「書かれていない = 持ち主の子会社の既定値 → 全体の既定値を引き継ぐ」。
   * 新規投稿しない時間帯 (サーバのローカル時刻)。 この間は返信だけ。 null で時間帯なし。
   */
  quiet_hours?: { start: string; end: string } | null;
  /** 投稿先の Discord channel を個別指定 (本社・子会社 guild)。 null なら投稿先 (target) の meta channel。 */
  discord_channel_id?: string | null;
  root_limit_per_day?: number;
  /** 名前の雰囲気。 */
  persona_hint?: string | null;
  max_chars: number;
  llm_limit_per_day: number;
  followup: FollowupConfig;
}

/** 持ち主の既定値を引き継いだ、 実行時の値。 */
export interface EffectiveConfig extends Omit<PatrolActionConfig, "quiet_hours" | "discord_channel_id" | "root_limit_per_day" | "persona_hint"> {
  quiet_hours: { start: string; end: string } | null;
  discord_channel_id: string | null;
  root_limit_per_day: number;
  persona_hint: string | null;
}

export interface SubsidiaryOption {
  id: string;
  name: string;
  display_name: string;
  enabled: boolean;
}

export interface PatrolDefaults {
  quiet_hours?: { start: string; end: string } | null;
  root_limit_per_day?: number;
  discord_channel_id?: string | null;
  persona_hint?: string | null;
  paused?: boolean;
  /** このサーバーの関心キーワード (近い話題ほど選ばれやすい)。 */
  topic_keywords?: string[];
}

export interface RuleView {
  id: string;
  description: string | null;
  trigger_type: "tick" | "event";
  tick_sec: number | null;
  event_kind: string | null;
  instructions: string;
  target: string | null;
  cooldown_sec: number;
  enabled: boolean;
  added_by: string;
  removed_at: number | null;
  config_version: number;
  revision: number;
  execution_mode: ExecutionMode;
  action_config: PatrolActionConfig | null;
  effective_config?: EffectiveConfig | null;
  /** 持ち主の子会社 (null = 本社)。 */
  subsidiary_id?: string | null;
  next_due_at: number | null;
  last_attempt_at: number | null;
  last_posted_at: number | null;
  readiness: { runnable: boolean; reason: string };
  last_run: { run_id: string; status: string; reason: string | null; created_at: number } | null;
}

export interface SourceView {
  sourceId: string;
  label: string;
  kind: "trend" | "activity";
  serviceCode: string;
  scopes: string[];
  status: "ready" | "unavailable";
  reason: string | null;
  lastFetchedAt: string | null;
  lastError: string | null;
}

export interface RunView {
  run_id: string;
  rule_id: string;
  rule_revision: number;
  trigger_key: string;
  action_kind: "pick" | "event" | "reply" | "followup";
  conversation_id: string | null;
  scope_key: string;
  channel: string;
  source_ref: string | null;
  material: { title?: string; excerpt?: string; url?: string; serviceCode?: string } | null;
  seed: number | null;
  decision: { candidateCount?: number; scored?: Array<{ itemId: string; score: number }>; sourceErrors?: string[] } | null;
  reason: string | null;
  status: string;
  render_attempts: number;
  llm_calls: number;
  rendered_text: string | null;
  chat_message_id: number | null;
  delivery_ref: string | null;
  error_code: string | null;
  created_at: number;
  updated_at: number;
}

export interface RunDetail {
  run: RunView;
  conversation: {
    conversation_id: string;
    status: string;
    reply_count: number;
    unprompted_count: number;
    expires_at: number;
    inbound: Array<{ inbound_chat_id: number; status: string; reason: string | null }>;
  } | null;
  rule_version: { revision: number; snapshot: unknown; created_at: number } | null;
}

export interface PreviewView {
  ok: boolean;
  reason: string;
  seed: number;
  candidateCount: number;
  scored: Array<{ itemId: string; score: number }>;
  picked: { itemId: string; title: string; excerpt: string; url?: string } | null;
  sourceErrors: Array<{ sourceId: string; code: string; message: string }>;
}

export interface VersionView {
  revision: number;
  actor: string;
  note: string | null;
  created_at: number;
  snapshot: Record<string, unknown>;
}

/** 1 日 1 回の学習の結果 (GET /v1/rules/:id/learning)。 */
export interface LearningRunView {
  run_id: string;
  day: string;
  status: "applied" | "skipped" | "rejected" | "failed";
  fragment_count: number;
  proposal: { summary?: string } & Record<string, unknown> | null;
  applied: Record<string, unknown> | null;
  reason: string | null;
  revision: number | null;
  created_at: number;
  /** 学習に使った会話 (発言者の名前は含まない)。 */
  sources?: LearningSourceView[];
}

/** 学習に使った会話 1 件。 message = 発言 (text) と返信先、 conversation = 巡回の投稿 (text) と返信。 */
export interface LearningSourceView {
  kind: "message" | "conversation";
  signal: Record<string, unknown> | null;
  created_at: number;
  text: string | null;
  reply_to_text: string | null;
  replies: string[];
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

async function call<T>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
  try {
    const res = await fetch(path, {
      method,
      ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const reason = typeof json.reason === "string" ? json.reason : typeof json.error === "string" ? json.error : `HTTP ${res.status}`;
      return { ok: false, status: res.status, error: reason };
    }
    return { ok: true, data: json as T };
  } catch (err) {
    return { ok: false, status: 0, error: (err as Error).message };
  }
}

/** 持ち主の絞り込み: "" = 全社、 "hq" = 本社、 それ以外は子会社 ID。 */
export type OwnerFilter = string;

export const rulesApi = {
  list: (owner: OwnerFilter = "") => call<{ rules: RuleView[] }>(
    "GET",
    owner === "" ? "/v1/rules" : owner === "hq" ? "/v1/rules?head_office=1" : `/v1/rules?subsidiary_id=${encodeURIComponent(owner)}`,
  ),
  subsidiaries: () => call<{ subsidiaries: SubsidiaryOption[] }>("GET", "/v1/subsidiaries"),
  patrolDefaults: (id: string) =>
    call<{ defaults: PatrolDefaults; updated_at: number | null; updated_by: string | null }>("GET", `/v1/subsidiaries/${encodeURIComponent(id)}/patrol-defaults`),
  setPatrolDefaults: (id: string, defaults: PatrolDefaults) =>
    call<{ defaults: PatrolDefaults }>("PUT", `/v1/subsidiaries/${encodeURIComponent(id)}/patrol-defaults`, { actor: "web", defaults }),
  sources: () => call<{ sources: SourceView[] }>("GET", "/v1/rules/sources"),
  engineEnabled: () => call<{ enabled: boolean }>("GET", "/v1/admin/rules-enabled"),
  setEngineEnabled: (enabled: boolean) => call<{ enabled: boolean }>("PUT", "/v1/admin/rules-enabled", { enabled }),
  create: (rule: Record<string, unknown>) => call<{ rule: RuleView }>("PUT", "/v1/rules", rule),
  update: (id: string, patch: Record<string, unknown>) => call<{ rule: RuleView }>("PATCH", `/v1/rules/${encodeURIComponent(id)}`, patch),
  toggle: (id: string) => call<{ rule: RuleView }>("POST", `/v1/rules/${encodeURIComponent(id)}/toggle`),
  preview: (body: { rule_id?: string; action_config?: unknown }) => call<{ preview: PreviewView }>("POST", "/v1/rules/preview", body),
  versions: (id: string) => call<{ versions: VersionView[] }>("GET", `/v1/rules/${encodeURIComponent(id)}/versions`),
  learning: (id: string) => call<{ runs: LearningRunView[] }>("GET", `/v1/rules/${encodeURIComponent(id)}/learning`),
  rollback: (id: string, expected_revision: number, to_revision: number) =>
    call<{ rule: RuleView }>("POST", `/v1/rules/${encodeURIComponent(id)}/rollback`, { expected_revision, to_revision }),
  runs: (q: { rule_id?: string; status?: string; cursor?: string | null }) => {
    const params = new URLSearchParams({ limit: "30" });
    if (q.rule_id) params.set("rule_id", q.rule_id);
    if (q.status) params.set("status", q.status);
    if (q.cursor) params.set("cursor", q.cursor);
    return call<{ runs: RunView[]; next_cursor: string | null }>("GET", `/v1/rules/runs?${params.toString()}`);
  },
  run: (runId: string) => call<RunDetail>("GET", `/v1/rules/runs/${encodeURIComponent(runId)}`),
};

export const fmtSec = (ts: number | null): string => (ts ? new Date(ts * 1000).toLocaleString() : "—");

/** 実行状態の表示名。 内部投稿と外部配達、 結果不明を分けて見せる (CC-PATROL-09)。 */
export const RUN_STATUS_LABEL: Record<string, string> = {
  claimed: "受付",
  material_selected: "素材選択済み",
  rendering: "生成中",
  rendered: "生成済み (未投稿)",
  delivery_pending: "Cc に投稿済み・配達確認待ち",
  delivered: "Discord へ配達済み",
  delivery_unknown: "配達結果不明",
  skipped: "見送り",
  failed: "失敗",
};

export const ACTION_LABEL: Record<RunView["action_kind"], string> = {
  pick: "定期の話題",
  event: "サービスの報告",
  reply: "返信への応答",
  followup: "反応への追投稿",
};
