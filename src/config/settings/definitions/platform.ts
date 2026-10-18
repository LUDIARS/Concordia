/**
 * 兄弟サービス接続・observability・ログ・キャッシュの設定定義。
 *
 * 兄弟サービスの base URL は `config/service-urls.ts` が読み出しの正本。
 * ポートの正本は Excubitor catalog で、 ここに出る既定値は env 未設定時の互換 fallback。
 */

import { validateLineWebhookTargetEntries } from "../../../line-webhook/targets.js";
import { normalizeNotionId } from "../../../rules/notion-map-rules.js";
import { NOTION_MAP_DEFAULT_LIMITS, NOTION_MAP_DEFAULT_ROOTS } from "../../../rules/notion-map-types.js";
import { validateDiscordChatRelayTargetEntries } from "../../../discord-chat-relay/targets.js";
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
  {
    key: "services.excubitor_runtime_config", section: "services",
    label: "Excubitor 注入設定",
    description: "Excubitorが注入するサービス実行時設定。Actio接続設定等の秘匿情報を含むため、設定有無のみ表示する。変更はExcubitor側で行う。",
    kind: "secret", envName: "EXCUBITOR_SERVICE_CONFIG_JSON", dbKey: null,
    defaultValue: null, editable: false,
  },
  // Actio のチャット連携 (CC-ACTIO-CHAT-01)。 通常は Excubitor の注入設定から読み、 env はその上書き。
  // 共有秘密と Discord の宛先 (team / workspace id) なので値は出さない。
  {
    key: "services.actio_chat_shared_secret", section: "services",
    label: "Actio チャット共有秘密",
    description: "Actio とのチャット連携の共有秘密。 通常は Excubitor 注入設定の actioChatSharedSecret から読む。 変更は Excubitor 側で行う。",
    kind: "secret", envName: "ACTIO_CHAT_SHARED_SECRET", dbKey: null,
    defaultValue: null, editable: false,
  },
  {
    key: "services.actio_chat_destinations", section: "services",
    label: "Actio チャット宛先",
    description: "チームごとの Actio チャット宛先 (teamId / subsidiaryId / workspaceId) の JSON 配列。 通常は Excubitor 注入設定の actioChatDestinations から読む。",
    kind: "secret", envName: "CONCORDIA_ACTIO_CHAT_DESTINATIONS", dbKey: null,
    defaultValue: null, editable: false,
  },
  // 技術相談の公開候補の投稿先 (spec/feature/tech-consultation.md §5)。 秘密は env から読まず DB + 設定画面の 1 系統。
  {
    key: "services.tabula_url", section: "services",
    label: "Tabula の接続先",
    description: "技術相談の公開候補を投稿する Tabula の URL。 未設定なら公開ボタンを出さず、 理由を候補に添える。",
    kind: "string", envName: null, dbKey: "services.tabula_url",
    defaultValue: null, editable: true,
    stringPattern: "^https?://", stringPatternDescription: "http:// または https:// で始まる URL",
  },
  {
    key: "services.tabula_import_token", section: "services",
    label: "Tabula 取り込みトークン",
    description: "Tabula の TABULA_IMPORT_TOKEN と同じ値。 schema_meta は secret-box で暗号化して保存され、 API には実値を返さない。",
    kind: "secret", envName: null, dbKey: "services.tabula_import_token",
    defaultValue: null, editable: true,
  },
  // 技術相談のファイル受け渡し (spec/feature/tech-consultation.md §6.4)。 秘密は env から読まず DB + 設定画面の 1 系統。
  {
    key: "services.google_drive_service_account", section: "services",
    label: "Google Drive サービスアカウント鍵",
    description: "技術相談のファイル受け渡しに使うサービスアカウントの鍵 (JSON をそのまま貼る)。 相談者は自分の Drive のフォルダをこのアカウントのメールアドレスへ編集者で共有する。 schema_meta は secret-box で暗号化して保存され、 API には実値を返さない。 未設定なら受け渡しを使わない。",
    kind: "secret", envName: null, dbKey: "services.google_drive_service_account",
    defaultValue: null, editable: true,
  },
  // 巡回チャットの知識 (spec/feature/patrol-chat.md「知識」)。
  {
    key: "services.chat_knowledge_public_projects", section: "services",
    label: "巡回チャットの知識で公開とするプロジェクト",
    description: "1 行 1 件の略称かプロジェクト名。 ここに載せたプロジェクトの README・spec・マージの断片だけを子会社・公開の宛先でも使う。 "
      + "載っていないもの (非公開・判断できないもの) と MELPOT 所属・Notion は本社の宛先だけで使う。",
    kind: "string-list", envName: null, dbKey: "services.chat_knowledge_public_projects",
    defaultValue: null, editable: true,
  },
  // Notion 記事マップ (spec/feature/patrol-chat.md「知識」)。 起点・除外・上限は秘密値ではない。
  {
    key: "services.notion_map_roots", section: "services",
    label: "Notion 記事マップの起点ページ",
    description: "1 行 1 件。 先頭は 32 桁のページ ID か公開ページの URL、 後ろの名前は注記。 起点から子ページ・子データベースを下ってクロールする。 "
      + "公開ページは URL (*.notion.site) を先頭に書けばクロールで読む。 それ以外は claude.ai の Notion コネクタ (MCP) で読む。 "
      + "未設定なら既定の起点 (ゲーム開発攻略ページと各学年の授業資料)。",
    kind: "string-list", envName: null, dbKey: "services.notion_map_roots",
    defaultValue: [...NOTION_MAP_DEFAULT_ROOTS], editable: true,
    validateItems: (items) => (items.every((item) => normalizeNotionId(item.trim().split(/\s+/)[0] ?? "") !== null)
      ? null : "each line must start with a 32-digit Notion page id"),
  },
  {
    key: "services.notion_map_exclude", section: "services",
    label: "Notion 記事マップの除外語 (追加)",
    description: "1 行 1 語。 題名やパスにこの語を含むページとその配下は読まない (保存もしない)。 "
      + "「個人ページ」「チーム」「タスクリスト」「チームテンプレート」は常に除外する。",
    kind: "string-list", envName: null, dbKey: "services.notion_map_exclude",
    defaultValue: null, editable: true,
  },
  {
    key: "services.notion_map_max_depth", section: "services",
    label: "Notion 記事マップの深さの上限",
    description: "起点を 0 として下る段数。",
    kind: "integer", envName: null, dbKey: "services.notion_map_max_depth",
    defaultValue: NOTION_MAP_DEFAULT_LIMITS.maxDepth, editable: true, minValue: 1, maxValue: 12,
  },
  {
    key: "services.notion_map_max_pages", section: "services",
    label: "Notion 記事マップの起点ごとのページ数の上限",
    description: "起点 1 つから読むページの数。 3 req/s の制限があるので、 増やすとクロールが長くなる。",
    kind: "integer", envName: null, dbKey: "services.notion_map_max_pages",
    defaultValue: NOTION_MAP_DEFAULT_LIMITS.maxPages, editable: true, minValue: 1, maxValue: 2000,
  },
  {
    key: "services.notion_map_page_bytes", section: "services",
    label: "Notion 記事マップのページごとの本文バイトの上限",
    description: "ページ 1 件から読む本文のバイト数。",
    kind: "integer", envName: null, dbKey: "services.notion_map_page_bytes",
    defaultValue: NOTION_MAP_DEFAULT_LIMITS.pageTextBytes, editable: true, minValue: 500, maxValue: 50000,
  },
  // LINE webhook のサービス (spec/feature/line-webhook-relay.md)。 秘密値ではない。 受け口が要求ごとに読む。
  {
    key: "services.line_webhook_targets", section: "services",
    label: "LINE webhook サービス",
    description: "POST /hooks/line/<channel> で受けた LINE webhook を振り分けるサービス。 1 行 1 件の JSON で書く "
      + "(例 {\"name\":\"mf\",\"url\":\"http://192.0.2.10:8080/integrations/line/webhook\",\"host\":\"mf-hook.example.test\",\"enabled\":true,\"channel\":\"ludiars\",\"keywords\":[\"おてつだい\"]})。 "
      + "name / channel は英小文字・数字・ハイフン (channel を省くと name と同じ)、 url は http / https、 host は任意で転送時の Host ヘッダ、 "
      + "keywords は呼びかけの言葉 (任意)。 保存すると再起動なしで効く。",
    kind: "string-list", envName: null, dbKey: "services.line_webhook_targets",
    defaultValue: null, editable: true,
    validateItems: validateLineWebhookTargetEntries,
  },
  // Discord チャット中継の転送先 (spec/feature/discord-chat-relay.md)。 LINE webhook 転送先と対。 秘密値ではない。
  {
    key: "services.discord_chat_relay_targets", section: "services",
    label: "Discord チャット中継 転送先",
    description: "指定チャンネル (とその中のスレッド) の人間の発言を転送し、 返事を元の発言への返信として投稿する。 1 行 1 件の JSON で書く "
      + "(例 {\"name\":\"mf\",\"url\":\"http://192.0.2.10:8080/integrations/discord\",\"host\":\"mf-hook.example.test\",\"channelIds\":[\"123456789012345678\"],\"enabled\":true})。 "
      + "1 つのチャンネルは 1 つの転送先にだけ書ける。 セッション中継のチャンネルは中継しない。 保存すると再起動なしで効く。",
    kind: "string-list", envName: null, dbKey: "services.discord_chat_relay_targets",
    defaultValue: null, editable: true,
    validateItems: validateDiscordChatRelayTargetEntries,
  },
  envInteger("services.lictor_sidecar_port", "services", "Lictor セッション接続ポート", "LICTOR_PORT", null,
    "LictorがMCP等へ渡す呼出元セッション専用のsidecarポート。固定の既定値は持たず、Cc本体で未設定でも異常ではない。"),
  // 会議の回答者リンク (CC-MEETING-LINK-01, src/meeting-links/config.ts)。 起動時に env から読む。
  envBoolean("services.meeting_link_enabled", "services", "会議の回答者リンク", "CONCORDIA_MEETING_LINK_ENABLED", false, "guild 限定の一回限りの回答者リンクを発行する。 true / false で明示する。"),
  envString("services.meeting_link_guild_id", "services", "会議リンクの guild", "CONCORDIA_MEETING_LINK_GUILD_ID", null, "回答者リンクを発行してよい Discord guild ID。 有効時は必須。"),
  envString("services.meeting_link_public_url", "services", "会議リンクの公開 URL", "CONCORDIA_MEETING_LINK_PUBLIC_URL", null, "回答者リンクに載せる公開 URL。 有効時は必須。"),
  envString("services.concordia_base_url", "services", "Concordia 自身の URL", "CONCORDIA_BASE_URL", "http://127.0.0.1:11111", "MCP サーバ等の別プロセスが叩く Concordia の loopback URL。"),
  envString("services.excubitor_url", "services", "Excubitor URL", "CONCORDIA_EXCUBITOR_URL", "http://127.0.0.1:17332", "サービス監視・起動制御を行う Excubitor の base URL。"),
  envString("services.excubitor_url_alias", "services", "Excubitor URL (慣用キー)", "EXCUBITOR_URL", null, "Excubitor 側の慣用 env。 CONCORDIA_EXCUBITOR_URL 未設定のときだけ使う。"),
  envString("services.memoria_url", "services", "Memoria URL", "CONCORDIA_MEMORIA_URL", "http://127.0.0.1:5180", "タスク管理 Memoria の base URL。"),
  envString("services.memoria_base_alias", "services", "Memoria URL (コマンド用)", "MEMORIA_BASE", null, "Discord の /mmtask コマンドが参照する Memoria URL。"),
  envString("services.anatomia_url", "services", "Anatomia URL", "ANATOMIA_BASE_URL", "http://127.0.0.1:4200", "リポジトリ解析 Anatomia の base URL。"),
  envInteger("services.anatomia_port", "services", "Anatomia ポート", "ANATOMIA_PORT", null, "キャッシュ統計とドメインレビューの取得先ポート。 正本は Excubitor catalog。"),
  envString("services.thaleia_url", "services", "Thaleia URL", "THALEIA_BASE_URL", "http://127.0.0.1:8890", "ドキュメント / 仕様 Thaleia の base URL。"),
  envString("services.villa_url", "services", "Villa URL", "CONCORDIA_VILLA_URL", "http://127.0.0.1:17610", "PC 台帳 Villa の base URL。 到達不能なら拠点タグ無しで動作する。"),
  envString("services.edge_path", "services", "Edge 実行ファイル", "CONCORDIA_EDGE_PATH", null, "ドメインレビューの層図を画像化する headless Edge の実行ファイル。 未設定なら既知の場所を自動検出する。"),
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
