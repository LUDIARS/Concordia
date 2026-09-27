# Cc ツール一覧と有効箇所

Cc はハーモナイザーと共通ツールセットを提供する。手順の選択・結果の解釈は
`skills/cc-development-tools/SKILL.md`、機械的な処理は以下のツールが担当する。
この資料はソースの能力一覧であり、全端末へ配備済みという意味ではない。
実配備は `GET /v1/developer-tools/catalog`、連携準備は `concordia_readiness` で確認する。

WebUI の「開発ツール」(`/developer-tools`) でも同じカタログを検索・確認できる。
設定の「リアクションWF」ではローカルスキルへの割当と初期定義を管理する。
RWF は本体内のエンジンを使用し、別リポジトリのコードや旧 `CONCORDIA_RWF_PLUGIN_PATH` を読み込まない。
初期定義は現在地確認・残作業整理・引き継ぎ資料。利用可能なローカルスキルだけを追加し、既存の絵文字割当を保持する。

## 共通開発ツール

有効箇所は Cc backend と `node <Concordia本体>/dist/mcp/core-server.js`。
MCP は `concordia-core` をクライアントに接続した時に使える。`LICTOR_PORT` で自身の session を特定する。
以下の下流サービスの MCP を個別に接続する必要はない。Cc が HTTP/CLI を代用する。

| ツール | 目的 | HTTP 入口または operation | 連携・準備 |
|---|---|---|---|
| concordia_tool_catalog | 能力・有効箇所の一覧 | GET /v1/developer-tools/catalog | Cc backend |
| concordia_readiness | 連携確認と準備案内 | readiness | active session、実 checkout |
| concordia_create_worktree | ローカル main 起点で wt 作成・登録 | POST /v1/implementation-tools/worktree | Git、Actio 登録、Cc project code |
| concordia_switch_branch | 自分が作成した別 branch の wt へ移る | POST /v1/implementation-tools/switch | 所有記録と実 Git identity。返る cwd を使用 |
| concordia_bind_work | 作業対象の再登録 | POST /v1/implementation-tools/bind | workspace 内の Git root |
| concordia_tasks_list | タスク一覧 | tasks_list | Actio の認証・project/owner/team/source |
| concordia_task_get | タスク本文取得 | task_get | actio:ID |
| concordia_task_create | 明示依頼されたタスク作成 | task_create | request UUID、title、body |
| concordia_task_update | タスク状態更新 | task_update | reference、pending/delegated/done/cancelled |
| concordia_critical_path | Gantt のクリティカルパス | critical_path | team binding または owner/Git origin に一致する PM project。複数時は pm_project_id |
| concordia_specifications | Pf の仕様モデル取得 | specifications | origin または本体 root から照合した Anatomia ID に一致する anatomiaRepo、認証済み Pf project |
| concordia_implementation_context | 実装位置・関連ドメイン調査 | implementation_context | Anatomia の本体 root 登録・解析 |
| concordia_impact_analysis | 変更範囲の決定的な計画 | impact_analysis | Anatomia /api/plan、llm=false。実測の動作保証ではない |
| concordia_vulnerability_check | npm lockfile の既知脆弱性照会 | vulnerability_check | package-lock v2/v3、OSV 接続 |
| concordia_tests_list | 登録テスト一覧 | tests_list | Augur CLI、対象 repo の登録 |
| concordia_tests_run | 指定 bundle のテスト受付 | tests_run | clean commit、request UUID、許可根拠 |
| concordia_test_result | 受付済み実行の結果 | test_result | 同じ session と request UUID |
| concordia_check_bash | 実行前のコマンド判定 | POST /v1/harness/gate | command と対象 cwd/branch。実行はしない |
| concordia_commit_work | 指定 path の commit | POST /v1/implementation-tools/commit | 作業範囲ガード |
| concordia_submit_work | workflow に従って成果提出 | POST /v1/implementation-tools/submit | clean commit、Revisor 等の設定 |
| concordia_control_service | 明示指示された起動・停止・再起動 | POST /v1/implementation-tools/service | Excubitor、本体 catalog、testing claim |

operation 表記の入口はすべて `POST /v1/developer-tools/execute`。
JSON は `{ "session_id": "自分のLictorから取得", "input": { "operation": "tasks_list" } }`。
他 session の ID を選ぶ手順にしない。API の成功と業務結果の合格を区別する。

Actio は Cc taskflow の source を持つタスクを対象とし、別 owner/team/source を取り込まない。
個人運用で team が未設定の時は、同じ owner/Git repo の PM project を照合する。未登録・重複は準備不足を返す。
Pf の認証が必要な環境では `authentication_required` を返す。ローカル認証への自動切替や資格情報の推測は行わない。
Anatomia の索引は登録された本体の解析であり、worktree 未コミット変更を解析済みとは扱わない。

脆弱性確認は依存の名前と固定版を OSV に送る。コード脆弱性・秘密漏出・ライセンスの検証は別。
照会契約: [OSV querybatch](https://google.github.io/osv.dev/post-v1-querybatch/)。未対応 lockfile は未検証として返す。
ローカル・Git 依存は `excluded` に列挙し、含まれる場合は `coverage=partial`、全体の `passed=null` を返す。
照会した依存だけの結果は `registry_dependencies_passed` であり、未検証依存を含めた安全性の保証ではない。

テストは `running` → `completed` / `failed`。合否は結果内の `passed` と Augur report を見る。
この受付は非 runtime テスト用。runtime を含む選択は準備案内を返し、本体・Excubitor の検証経路へ戻す。
Cc 中断後に結果が保存されていないものは `outcome_unknown`。同じ ID を照会し、Augur の既存 run を確認する。
新規 request ID による無条件再実行はしない。再起動・起動を含むテストは本体から Excubitor 経由で行う。

## 既存 core ツール

同じ `concordia-core` で有効。既存 API の認可・副作用・呼出条件を維持する。

| ツール | API 代用 |
|---|---|
| concordia_list_sessions / concordia_get_session | GET /v1/sessions、GET /v1/sessions/:id |
| concordia_get_session_stat / concordia_list_all_stats | GET /v1/stat/:id、GET /v1/stat |
| concordia_pr_queue | GET /v1/prs |
| concordia_get_pending_tasks | GET /v1/sessions/:id/pending-tasks |
| concordia_get_conflicts | GET /v1/monitor/conflicts |
| concordia_post_chat / concordia_recent_chat | POST /v1/chat、GET /v1/chat。通常の投稿は自身の Lictor 経由 |
| concordia_list_session_logs / concordia_get_session_log | GET /v1/session-logs、GET /v1/session-logs/:id |
| concordia_context_packet | GET /v1/sessions/:id/context |
| concordia_harness_context / concordia_harness_gate / concordia_harness_intent / concordia_harness_audit | /v1/harness の既存各 endpoint |
| concordia_get_settings / concordia_update_settings | GET / PUT /v1/admin/settings |
| concordia_list_teams / concordia_update_team | GET /v1/teams、PATCH /v1/teams/:id |

## 別 MCP サーバーの有効箇所

| 起動入口 | ツール | 代用・条件 |
|---|---|---|
| dist/mcp/pr-server.js | pr_submit / pr_status / pr_merge | /v1/prs/local/direct、/v1/prs/revisor、/v1/prs/local/:id/merge。merge は Cc の人間指示者権限が必要 |
| dist/mcp/delegation-server.js | delegation_list_templates / delegation_invoke | /v1/delegation/templates、既存委託 API。委託指示のある時だけ使用 |
| dist/mcp/vestigium-server.js | vestigium_list_services / vestigium_tail / vestigium_search / vestigium_recent_errors | 既存の Vestigium 読取 adapter。汎用 HTTP 代用はこの変更で追加しない |

これらは core MCP への接続だけでは有効にならない。各クライアントの MCP 接続設定を確認する。
外部アプリの独自 MCP だけが提供する機能は、Cc が列挙していない API で代用済みと扱わない。

## Castra との境界

`harness-guard.mjs` の reset-hard、SQLite ファイル置換、backup 削除、worktree merge のチェックを
Cc の `bash-known-hazards` predicate に移した。Cc gate を呼ぶ MCP/API/既存 hook で同じ判定を使用する。
magic comment による許可拡大はしない。既存 Castra hook の撤去・端末設定変更は自動では行わない。
旧 hook が動く端末は二重チェックの可能性があり、Cc 接続を確認してから薄い呼出 adapter に移行する。

準備不足は reason と next_action にまとめる。停止・未登録・認証不足・未解析を空の成功にしない。
公開資料、能力カタログ、現在の疎通結果を分けて確認する。
