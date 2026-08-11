/**
 * 兄弟サービス接続・observability・ログ・キャッシュの設定定義。
 *
 * 兄弟サービスの base URL は `config/service-urls.ts` が読み出しの正本。
 * ポートの正本は Excubitor catalog で、 ここに出る既定値は env 未設定時の互換 fallback。
 */

import type { SettingDefinition } from "../types.js";

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

export const SERVICE_SETTINGS: readonly SettingDefinition[] = [
  envString("services.concordia_base_url", "services", "Concordia 自身の URL", "CONCORDIA_BASE_URL", "http://127.0.0.1:11111", "MCP サーバ等の別プロセスが叩く Concordia の loopback URL。"),
  envString("services.excubitor_url", "services", "Excubitor URL", "CONCORDIA_EXCUBITOR_URL", "http://127.0.0.1:17332", "サービス監視・起動制御を行う Excubitor の base URL。"),
  envString("services.excubitor_url_alias", "services", "Excubitor URL (慣用キー)", "EXCUBITOR_URL", null, "Excubitor 側の慣用 env。 CONCORDIA_EXCUBITOR_URL 未設定のときだけ使う。"),
  envString("services.memoria_url", "services", "Memoria URL", "CONCORDIA_MEMORIA_URL", "http://127.0.0.1:5180", "タスク管理 Memoria の base URL。"),
  envString("services.memoria_base_alias", "services", "Memoria URL (コマンド用)", "MEMORIA_BASE", null, "Discord の /mmtask コマンドが参照する Memoria URL。"),
  envString("services.anatomia_url", "services", "Anatomia URL", "ANATOMIA_BASE_URL", "http://127.0.0.1:4200", "リポジトリ解析 Anatomia の base URL。"),
  envInteger("services.anatomia_port", "services", "Anatomia ポート", "ANATOMIA_PORT", null, "キャッシュ統計の取得先ポート。 正本は Excubitor catalog。"),
  envString("services.thaleia_url", "services", "Thaleia URL", "THALEIA_BASE_URL", "http://127.0.0.1:8890", "ドキュメント / 仕様 Thaleia の base URL。"),
  envString("services.villa_url", "services", "Villa URL", "CONCORDIA_VILLA_URL", "http://127.0.0.1:17610", "PC 台帳 Villa の base URL。 到達不能なら拠点タグ無しで動作する。"),
  envInteger("services.mcp_fetch_timeout_ms", "services", "MCP fetch タイムアウト (ms)", "CONCORDIA_MCP_FETCH_TIMEOUT_MS", 10_000, "MCP tool call が backend の hang で無限に待たないための打ち切り時間。"),
  envString("services.vestigium_catalog_path", "services", "Vestigium catalog パス", "VESTIGIUM_CATALOG_PATH", null, "vestigium MCP server が参照する service catalog の場所。"),
] as const;

export const OBSERVABILITY_SETTINGS: readonly SettingDefinition[] = [
  envBoolean("observability.error_autofix", "observability", "error 自動修正", "CONCORDIA_ERROR_AUTOFIX", false, "検知した error task の自動 fix を有効にする。"),
  envString("observability.error_autofix_cwd", "observability", "自動修正の作業ディレクトリ", "CONCORDIA_ERROR_AUTOFIX_CWD", null, "auto-fix セッションを回す working directory。"),
  envString("observability.error_watch_logs_root", "observability", "エラー監視のログルート", "CONCORDIA_ERROR_WATCH_LOGS_ROOT", null, "Discord エラー監視が tail するログのルート。 未設定なら監視しない。"),
  envInteger("observability.error_watch_interval_sec", "observability", "エラー監視の間隔 (秒)", "CONCORDIA_ERROR_WATCH_INTERVAL_SEC", 30, "ログ tail の間隔。 最小 10。"),
  envBoolean("observability.metrics_enabled", "observability", "ホストメトリクス採取", "CONCORDIA_METRICS_ENABLED", true, "CPU / メモリ等のホストメトリクスを採取する。"),
  envInteger("observability.metrics_interval_ms", "observability", "メトリクス採取間隔 (ms)", "CONCORDIA_METRICS_INTERVAL_MS", 30_000, "ホストメトリクスの採取周期。"),
  envInteger("observability.metrics_retention_hours", "observability", "メトリクス保持 (時間)", "CONCORDIA_METRICS_RETENTION_HOURS", 24, "host_metrics を保持する時間。"),
  envBoolean("observability.aop_metrics", "observability", "AOP メトリクス", "CONCORDIA_AOP_METRICS", false, "関数境界の計測を有効にする (診断用)。"),
  envString("observability.aop_metrics_stream", "observability", "AOP メトリクスの出力先", "CONCORDIA_AOP_METRICS_STREAM", null, "AOP 計測の書き出し先ストリーム。"),
  envInteger("observability.loop_max_consecutive_failures", "observability", "周期ループの連続失敗上限", "CONCORDIA_LOOP_MAX_CONSECUTIVE_FAILURES", 5, "この回数連続で失敗した周期ループを個別停止する。 停止状態は /health に出る。"),
  envString("observability.git_bash_path", "observability", "git-bash パス", "CLAUDE_CODE_GIT_BASH_PATH", null, "Windows で claude CLI を spawn する際の git-bash パス。 未設定なら既知の場所を自動検出する。"),
  envBoolean("observability.watch_report_dependencies", "observability", "依存レポート監視", "WATCH_REPORT_DEPENDENCIES", false, "依存関係レポートの監視を有効にする。"),
] as const;

export const LOGGING_SETTINGS: readonly SettingDefinition[] = [
  {
    key: "logging.level",
    section: "logging",
    label: "ログレベル",
    description: "出力する最小ログレベル。",
    kind: "enum",
    envName: "CONCORDIA_LOG_LEVEL",
    dbKey: null,
    defaultValue: null,
    editable: false,
    enumValues: ["debug", "info", "warn", "error"],
  },
  envBoolean("logging.to_file", "logging", "ファイル出力", "CONCORDIA_LOG_FILE", false, "ログをファイルにも書き出す。"),
  envString("logging.file_path", "logging", "ログファイルパス", "CONCORDIA_LOG_FILE_PATH", null, "ファイル出力時の書き出し先。"),
  envBoolean("logging.vestigium", "logging", "Vestigium 連携", "CONCORDIA_VESTIGIUM", false, "共有ロガー Vestigium へ送出する。"),
  envInteger("logging.vestigium_retention_days", "logging", "Vestigium 保持 (日)", "VESTIGIUM_RETENTION_DAYS", null, "Vestigium 側の保持期間。"),
] as const;

export const CACHE_SETTINGS: readonly SettingDefinition[] = [
  envBoolean("cache.http_enabled", "cache", "HTTP キャッシュ", "CONCORDIA_HTTP_CACHE_ENABLED", true, "GET 応答の小さな L1 キャッシュ。 TTL はコード上の固定ポリシー。"),
  envBoolean("cache.http_redis_read", "cache", "HTTP キャッシュを Redis から読む", "CONCORDIA_HTTP_CACHE_REDIS_READ", false, "L1 キャッシュの読み出しに Redis を使う。"),
  envBoolean("cache.redis_enabled", "cache", "Redis を使う", "CONCORDIA_REDIS_ENABLED", false, "共有キャッシュ用 Redis に接続する。 Redis 不在環境では未設定のままにする。"),
  envString("cache.redis_url", "cache", "Redis URL", "CONCORDIA_REDIS_URL", null, "接続先 Redis。"),
  envString("cache.redis_url_alias", "cache", "Redis URL (慣用キー)", "REDIS_URL", null, "CONCORDIA_REDIS_URL 未設定時に使う慣用 env。"),
  envString("cache.redis_prefix", "cache", "Redis キー prefix", "CONCORDIA_REDIS_PREFIX", null, "他サービスとキーが衝突しないための prefix。"),
  envBoolean("cache.work_repos_redis_read", "cache", "repo 一覧を Redis から読む", "CONCORDIA_WORK_REPOS_CACHE_REDIS_READ", false, "Work ページの repo 一覧キャッシュを Redis から読む。"),
] as const;
