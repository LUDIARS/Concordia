/**
 * ワークフロー・PR キュー・連合・runtime 制御の設定定義。
 *
 * runtime 制御 (チャットミュート・予算等) は DB (`schema_meta`) が正本で env を持たない。
 * ワークフロー有効化フラグ (`workflow.*`) は別 PR で追加されるため**ここでは定義しない**
 * (レジストリは後からキーを足せる形にしてある)。
 */

import type { SettingDefinition } from "../types.js";

function envBoolean(
  key: string,
  section: SettingDefinition["section"],
  label: string,
  envName: string,
  defaultValue: boolean,
  description: string,
): SettingDefinition {
  return { key, section, label, description, kind: "boolean", envName, dbKey: null, defaultValue, editable: false };
}

function envInteger(
  key: string,
  section: SettingDefinition["section"],
  label: string,
  envName: string,
  defaultValue: number | null,
  description: string,
): SettingDefinition {
  return { key, section, label, description, kind: "integer", envName, dbKey: null, defaultValue, editable: false };
}

function envString(
  key: string,
  section: SettingDefinition["section"],
  label: string,
  envName: string,
  defaultValue: string | null,
  description: string,
): SettingDefinition {
  return { key, section, label, description, kind: "string", envName, dbKey: null, defaultValue, editable: false };
}

export const WORKFLOW_SETTINGS: readonly SettingDefinition[] = [
  {
    key: "workflow.reaction_enabled",
    section: "workflow",
    label: "リアクションワークフロー",
    description: "絵文字リアクションで処理を起動する仕組みを有効にする。",
    kind: "boolean",
    envName: "CONCORDIA_REACTION_WORKFLOW",
    dbKey: "admin.reaction_workflow_enabled",
    defaultValue: false,
    editable: true,
  },
  {
    key: "workflow.cc_enabled",
    section: "workflow",
    label: "Cc ワークフロー",
    description: "Cc 側のワークフロー処理を有効にする。",
    kind: "boolean",
    envName: "CONCORDIA_CC_WORKFLOW",
    dbKey: "admin.cc_workflow_enabled",
    defaultValue: false,
    editable: true,
  },
  {
    key: "workflow.revisor_auto_submit_enabled",
    section: "workflow",
    label: "Revisor 自動提出",
    description: "セッション終了時に作業ブランチを Revisor の local PR として自動提出する。 既定 ON (レビュー発火が黙って消えないようにするため)。",
    kind: "boolean",
    envName: null,
    dbKey: "admin.revisor_auto_submit_enabled",
    defaultValue: true,
    editable: true,
  },
  {
    key: "workflow.reaction_emoji_overrides",
    section: "workflow",
    label: "絵文字 → アクション対応",
    description: "リアクション絵文字と起動アクションの対応表。 対応の追加・削除は専用 UI で行う。",
    kind: "json",
    envName: null,
    dbKey: "admin.reaction_emoji_overrides",
    defaultValue: {},
    editable: false,
    managedBy: "設定 > リアクションワークフロー",
  },
  envString("workflow.rwf_plugin_path", "workflow", "RWF プラグインパス", "CONCORDIA_RWF_PLUGIN_PATH", null, "リアクションワークフローの外部プラグイン読み込み先。"),
  envString("workflow.mode", "workflow", "ワークフローモード", "CONCORDIA_WORKFLOW_MODE", null, "workflow worker プロセスの動作モード識別子。"),
  envString("workflow.director_impl_call_name", "workflow", "Director 実装委託テンプレ", "CONCORDIA_DIRECTOR_IMPL_CALL_NAME", "claude-sonnet-5-impl", "Director 巡回が実装工程の委託に使う call name。"),
  envString("workflow.director_ask_call_name", "workflow", "Director 問診委託テンプレ", "CONCORDIA_DIRECTOR_ASK_CALL_NAME", "claude-sonnet-5-ask", "Director 巡回が人間への問いを組み立てさせる読み取り専用セッションの call name。"),
] as const;

export const PR_QUEUE_SETTINGS: readonly SettingDefinition[] = [
  envBoolean("pr_queue.reconcile_enabled", "pr-queue", "PR 突合を有効化", "CONCORDIA_PR_RECONCILE_ENABLED", false, "登録済み PR の状態を GitHub と突き合わせる。"),
  envInteger("pr_queue.reconcile_min", "pr-queue", "PR 突合の間隔 (分)", "CONCORDIA_PR_RECONCILE_MIN", null, "突合の実行間隔。"),
  envBoolean("pr_queue.full_sync_enabled", "pr-queue", "PR 全件同期を有効化", "CONCORDIA_PR_FULL_SYNC_ENABLED", false, "Organization の PR を全件取得して同期する。"),
  envInteger("pr_queue.full_sync_min", "pr-queue", "全件同期の間隔 (分)", "CONCORDIA_PR_FULL_SYNC_MIN", null, "全件同期の実行間隔。"),
  envInteger("pr_queue.full_sync_limit", "pr-queue", "全件同期の取得上限", "CONCORDIA_PR_FULL_SYNC_LIMIT", null, "1 回の同期で取得する PR 数の上限。"),
  envString("pr_queue.sync_owner", "pr-queue", "同期対象の owner", "CONCORDIA_PR_SYNC_OWNER", null, "同期対象の GitHub owner。 未設定ならワークスペースの Organization に従う。"),
  // 旧 `pr_queue.revisor_token` (env CONCORDIA_REVISOR_TOKEN) は廃止。 Revisor は変更系を
  // workflow token 1 本で認可するので、 別トークンは存在しない。
  {
    key: "pr_queue.revisor_workflow_token",
    section: "pr-queue",
    label: "Revisor ワークフロートークン",
    description:
      "local PR の提出・マージ・再審査に使う Revisor のトークン。 正本は DB (revisor_config) "
      + "で、 secret-box 暗号化して保存する。 env からは読まない。 API には実値を返さない。",
    kind: "secret",
    envName: null,
    dbKey: "workflow_token_enc",
    dbStore: "revisor",
    defaultValue: null,
    editable: false,
    managedBy: "設定 > Revisor",
  },
] as const;

export const FEDERATION_SETTINGS: readonly SettingDefinition[] = [
  envBoolean("federation.listen_enabled", "federation", "本社 listener を立てる", "CONCORDIA_FEDERATION_LISTEN", false, "拠点からの接続を受ける連合 listener を起動する。 既定 OFF (opt-in)。"),
  envString("federation.listen_host", "federation", "listener の bind ホスト", "CONCORDIA_FEDERATION_LISTEN_HOST", null, "連合 listener の待ち受けアドレス。"),
  envInteger("federation.listen_port", "federation", "listener のポート", "CONCORDIA_FEDERATION_LISTEN_PORT", null, "連合 listener のポート。 listener 有効時は必須 (暗黙の既定ポートで外部面を立てない)。"),
  envString("federation.hq_url", "federation", "本社 URL (拠点ロール)", "CONCORDIA_FEDERATION_HQ_URL", null, "拠点が接続する本社の wss:// URL。 未設定なら拠点クライアントは起動しない。"),
  envString("federation.site_id", "federation", "拠点 ID", "CONCORDIA_FEDERATION_SITE_ID", null, "この拠点の識別子。"),
  {
    key: "federation.site_token",
    section: "federation",
    label: "拠点トークン",
    description: "拠点が本社へ接続するときの認証トークン。 API には実値を返さない。",
    kind: "secret",
    envName: "CONCORDIA_FEDERATION_SITE_TOKEN",
    dbKey: null,
    defaultValue: null,
    editable: false,
  },
  envInteger("federation.outbox_max_rows", "federation", "outbox の上限行数", "CONCORDIA_FEDERATION_OUTBOX_MAX", 10_000, "拠点別 outbox の上限。 超過は最古から破棄。"),
  envInteger("federation.outbox_ttl_sec", "federation", "outbox の TTL (秒)", "CONCORDIA_FEDERATION_OUTBOX_TTL_SEC", 604_800, "outbox エントリの保持期間。 超過は破棄。"),
] as const;

export const RUNTIME_SETTINGS: readonly SettingDefinition[] = [
  {
    key: "runtime.chat_muted",
    section: "runtime",
    label: "チャット投稿をミュート",
    description: "ON の間、 Cc からのチャット投稿を止める。 既定 ON。",
    kind: "boolean",
    envName: null,
    dbKey: "admin.chat_muted",
    defaultValue: true,
    editable: true,
  },
  {
    key: "runtime.rules_enabled",
    section: "runtime",
    label: "rule engine を有効化",
    description: "rule engine による自動処理を有効にする。 既定 OFF。",
    kind: "boolean",
    envName: null,
    dbKey: "admin.rules_enabled",
    defaultValue: false,
    editable: true,
  },
  {
    key: "runtime.lictor_mode",
    section: "runtime",
    label: "Lictor 実行モード",
    description: "auto / dev / prod。 dev はチェックアウトの dist、 prod は配布 exe を使う。",
    kind: "enum",
    envName: null,
    dbKey: "admin.lictor_mode",
    defaultValue: "auto",
    editable: true,
    enumValues: ["auto", "dev", "prod"],
  },
  {
    key: "runtime.lictor_dev_path",
    section: "runtime",
    label: "Lictor dev パス",
    description: "dev モードで使う Lictor チェックアウトの場所。",
    kind: "string",
    envName: null,
    dbKey: "admin.lictor_dev_path",
    defaultValue: null,
    editable: true,
  },
  {
    key: "runtime.lictor_prod_exe",
    section: "runtime",
    label: "Lictor prod 実行ファイル",
    description: "prod モードで使う Lictor 実行ファイル。",
    kind: "string",
    envName: null,
    dbKey: "admin.lictor_prod_exe",
    defaultValue: null,
    editable: true,
  },
  {
    key: "runtime.daily_token_budget",
    section: "runtime",
    label: "1 日のトークン予算",
    description: "0 で無制限。 超過時の扱いはコスト機能側の判断に従う。",
    kind: "integer",
    envName: null,
    dbKey: "admin.daily_token_budget",
    defaultValue: 0,
    editable: true,
    minValue: 0,
  },
  {
    key: "runtime.mention_user_id",
    section: "runtime",
    label: "メンション先ユーザ ID",
    description: "人間の判断を仰ぐときにメンションする相手。 空ならメンションしない。",
    kind: "string",
    envName: null,
    dbKey: "admin.mention_user_id",
    defaultValue: null,
    editable: true,
  },
  {
    key: "runtime.cron_job_overrides",
    section: "runtime",
    label: "cron ジョブの呼び出し先上書き",
    description: "内部 cron の job 名 → delegation call 名の対応表。 追加・削除は専用 UI で行う。",
    kind: "json",
    envName: null,
    dbKey: "admin.cron_job_overrides",
    defaultValue: {},
    editable: false,
    managedBy: "設定 > cron ジョブ",
  },
  {
    key: "runtime.cost_mode",
    section: "runtime",
    label: "コスト集計モード",
    description: "コスト worker の動作モード識別子。",
    kind: "string",
    envName: "CONCORDIA_COST_MODE",
    dbKey: null,
    defaultValue: null,
    editable: false,
  },
  {
    key: "runtime.cost_feed_log",
    section: "runtime",
    label: "コストフィードのログ",
    description: "コストフィードの読み出し元ログファイル。",
    kind: "string",
    envName: "CONCORDIA_COST_FEED_LOG",
    dbKey: null,
    defaultValue: null,
    editable: false,
  },
] as const;
