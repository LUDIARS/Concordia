---
type: setup
title: "Concordia 設定キー正本 (config-reference)"
description: "Concordia の全環境変数設定キーを集約した正本リファレンス。コア起動・LLM・Discord/Slack bot・セッション管制・observability・ログ・hook・PR キュー・error 自動対応の 9 カテゴリを網羅し、既定値・読み出し元ファイル・信頼境界ルールを明記する。"
service: concordia
domain: governance
tags:
  - typescript
  - sqlite
  - discord
  - slack
  - configuration
  - env
  - auth
  - monitoring
status: implemented
related:
  - ../interface/service-schema.md
  - spawn.md
  - discord.md
  - slack.md
  - observability.md
updated: 2026-06-30
---


# Concordia 設定キー正本 (config-reference)

最終更新: 2026-05-31

Concordia の **全 env 設定キー** をここに集約する。 各キーの「読み出し元 (src の実ファイル)」を根拠として明記しているので、 値の意味・既定値はこの表を正本とする。 用途別の設定手順は [`README.md`](README.md) の各ガイドを参照。

設定の与え方は 2 通り:

- サービス cwd 直下の `.env` (起動時 `src/server.ts:loadDotEnv()` が読む。 `#` 始まりはコメント、 `KEY=VALUE`、 既存の `process.env` が優先)
- プロセス起動者が直接渡す環境変数 (systemd / Start-Process など)。 `.env` より優先される (loadDotEnv は `process.env[key] === undefined` のときだけ代入する)

---

## 1. コア (本体起動)

`src/shared/config.ts:loadConfig()` が読む。 ここが本体設定の正本。

| キー | 既定値 | 意味 |
|------|--------|------|
| `CONCORDIA_HOST` | `127.0.0.1` | bind するホスト。 loopback 前提 (無認証)。 非 loopback (0.0.0.0 等) に変える場合は `CONCORDIA_ADMIN_TOKEN` 必須 (未設定なら起動拒否)。 下記「信頼境界」節参照。 |
| `CONCORDIA_PORT` | `11111` | backend HTTP ポート (loopback)。 |
| `CONCORDIA_DB_PATH` | 空 → `<cwd>/concordia.db` | SQLite ファイルパス。 空なら cwd 直下 (`defaultDbPath()`)。 |
| `CONCORDIA_LOST_AFTER_SEC` | `1800` (30 分) | heartbeat 途絶からこの秒数で `status=lost` に落とす。 |
| `CONCORDIA_ABANDONED_AFTER_SEC` | `86400` (24h) | lost からこの秒数で `abandoned`。 |
| `CONCORDIA_LOST_PURGE_AFTER_SEC` | `1800` | lost を purge するまでの猶予秒。 |
| `CONCORDIA_PURGE_AFTER_DAYS` | `90` | session_events の auto-purge 期間 (日)。 |
| `CONCORDIA_TRANSCRIPT_LOG_RETENTION_DAYS` | `CONCORDIA_PURGE_AFTER_DAYS`（既定 `90`） | transcript_logs の保持期間 (日)。 |
| `CONCORDIA_RULES_LOG_RETENTION_DAYS` | `CONCORDIA_PURGE_AFTER_DAYS`（既定 `90`） | rules_log の保持期間 (日)。 |
| `CONCORDIA_SESSION_STATS_RETENTION_DAYS` | `CONCORDIA_PURGE_AFTER_DAYS`（既定 `90`） | session_stats の保持期間 (日)。 |
| `CONCORDIA_SWEEPER_INTERVAL_MS` | `60000` (60 秒) | sweeper (lost/abandoned/purge 判定) の周期。 |
| `CONCORDIA_DB_APPLY_EXCUBITOR_DROP` | 未設定 | `.bak` 作成済みの場合だけ `1` にし、旧 Excubitor テーブルの one-shot DROP + VACUUM を許可する。通常は設定しない。 |
| `CONCORDIA_MAX_AI_RULES` | `10` | AI proposer が新 rule を提案する上限。 enabled な ai 由来 rule がこれ以上なら proposer は claude を呼ばず skip (rule 雪だるま防止)。 |
| `CONCORDIA_SPAWN_DEFAULT_CWD` | 空 (Win + `E:\Document\Ars` 存在時は自動採用) | `/v1/spawn` / `/v1/admin/spawn-session` で `cwd` 省略時の既定。 解決順は [spawn ガイド](spawn.md) 参照。 |
| `CONCORDIA_ADMIN_TOKEN` | 空 | admin / sweeper エンドポイントの bearer token。 設定すると `/v1/admin/*` と `/v1/sweeper/run` が `Authorization: Bearer <token>` (または `X-Concordia-Admin-Token`) を要求する。 詳細は下記「信頼境界」節。 |

> 注: `CONCORDIA_LOST_AFTER_SEC` の既定は **1800 秒 (30 分)** (`.env.example` も同値に統一済み)。 Stop hook が turn 毎にしか発火せず idle ≠ 終了のため、 これより短くすると健全な作業中セッションが lost 化しやすい。 過去に `.env.example` が 300 (5 分) を配布していた時期があるので、 運用中の実 env が 300 のままになっていないか確認すること。

### 信頼境界 (trust boundary)

Concordia の管理系エンドポイント (`/v1/admin/*`、 `/v1/sweeper/run`、 `/v1/admin/truncate-sessions`、 `/v1/admin/spawn-session` 等) は **元来 loopback (127.0.0.1) 前提で無認証**。 同一マシンからしか到達しないことを信頼境界としている。 2026-06-11 の脆弱性レビュー (CWE-306 / CWE-1188) を受けて、 次の 2 段で境界を担保する。

1. **bind host 判定** (`shared/config.ts:isLoopbackHost()`): `127.0.0.0/8` / `::1` / `localhost` / 空 (既定 bind) は loopback。 `0.0.0.0` / `::` / LAN IP / hostname は非 loopback。
2. **token による保護** (`shared/admin-auth.ts`):
   - **loopback + token 未設定** (既定): 従来どおり admin API は無認証で使える。
   - **token 設定済み**: loopback でも admin / sweeper は bearer 認証を要求する。
   - **非 loopback bind**: 起動時 (`server.ts`) に warn を出し、 `CONCORDIA_ADMIN_TOKEN` 未設定なら **起動拒否** (throw)。 LAN/0.0.0.0 公開時に無認証 admin API が晒されるのを防ぐ。

> つまり LAN へ公開したい場合は `CONCORDIA_HOST=0.0.0.0` + `CONCORDIA_ADMIN_TOKEN=<秘密値>` を必ずセットで指定する。 token はクライアント (Lictor / dashboard / Web UI proxy) 側も同じ値を `Authorization: Bearer` で送る必要がある。

---

## 2. LLM (report / rule proposer / persona feedback)

| キー | 既定値 | 読み出し元 | 意味 |
|------|--------|-----------|------|
| `ANTHROPIC_API_KEY` | 空 | `config.ts:72`, `discord/webhook-pool.ts:127` | report 生成等で使う Anthropic API key。 空なら LLM 機能は無効。 |
| `CONCORDIA_REPORT_MODEL` | `claude-haiku-4-5` | `config.ts:73` | 終了レポート等の LLM モデル名。 |
| `CONCORDIA_DISABLE_CLAUDE` | 未設定 (`1` で緊急 OFF) | `admin/state.ts` / `rules/proposer.ts` / `report/generator.ts` / `daily/generator.ts` / `personas/feedback.ts` | **緊急 hard-OFF**。 `1` で rule engine / proposer / report 等の claude CLI 呼び出しを全経路で止める。 通常の ON/OFF は下記の runtime スイッチで行い、 この env は `rules_enabled=true` でも勝つ。 |
| `CONCORDIA_CLAUDE_TIMEOUT_MS` | `120000` | `rules/claude-runner.ts:15` | rule 用 claude CLI subprocess の timeout (ms)。 |

> **runtime スイッチ (env ではない)**: chat 投稿 / rule engine の通常 ON/OFF は env ではなく
> `schema_meta` 永続のスイッチで制御する (再起動不要、 Web UI Rules ページ / admin API)。 **既定は OFF 寄り**。
> 詳細は [core.md の「runtime 切替 (kill switch)」](core.md#runtime-切替-kill-switch)。
>
> | スイッチ | 既定 | admin API |
> |---------|------|-----------|
> | `chat_muted` | `true` | `GET`/`PUT /v1/admin/chat-mute` |
> | `rules_enabled` | `false` | `GET`/`PUT /v1/admin/rules-enabled` |
> | `rule_proposer_interval` | `3600`s (60..86400) | `GET`/`PUT /v1/admin/rule-proposer-interval` |

---

## 3. Discord bot

`src/discord/types.ts:readDiscordEnv()` と `src/discord/bot.ts` が読む。 詳細は [discord.md](discord.md)。

| キー | 既定値 | 読み出し元 | 意味 |
|------|--------|-----------|------|
| `CONCORDIA_DISCORD_ENABLED` | 空 (`1` で有効) | `discord/types.ts:35` | `1` のときだけ bot 起動。 それ以外は完全 no-op。 |
| `CONCORDIA_DISCORD_TOKEN` | 空 | `discord/types.ts:36` | Bot token。 未設定なら起動 skip。 |
| `CONCORDIA_DISCORD_GUILD_ID` | 空 | `discord/types.ts:37` | 招待先 guild (server) ID。 未設定なら起動 skip。 |
| `CONCORDIA_DISCORD_APPLICATION_ID` | 空 | `discord/types.ts:38` | slash command 登録に使う Application ID。 未設定だと bot は起動するが slash command が未登録 (warn ログ)。 |
| `CONCORDIA_DISCORD_COST_REFRESH_MIN` | `10` (最小 10) | `discord/bot.ts:157` | cost channel メッセージの更新間隔 (分)。 10 未満は 10 に丸め。 |
| `CONCORDIA_DISCORD_MONITOR_REFRESH_MIN` | `10` (最小 10) | `discord/bot.ts:182` | monitor (サービス状態) channel の更新間隔 (分)。 |
| `CONCORDIA_DISCORD_PR_QUEUE_REFRESH_MIN` | `15` (最小 10) | `discord/bot.ts:207` | PR キュー channel の更新間隔 (分)。 |
| `CONCORDIA_DISCORD_WORKING_IDLE_SEC` | `60` (最小 15) | `discord/bot.ts:273` | 「作業中」インジケータを消す無進捗秒数。 |
| `CONCORDIA_DISCORD_WORK_IDLE_SEC` | `600` (最小 60) | `discord/bot.ts:300` | channel work-state を idle に戻す無進捗秒数。 |
| `CONCORDIA_DISCORD_TRANSCRIPT_LOG_MAX` | `1200` | `discord/egress.ts:216` | transcript ログ転送の最大件数。 |

---

## 3.5 Slack bot

`src/slack/types.ts:readSlackEnv()` が読む env は **初期 bootstrap / フォールバック**。
推奨はサービス内設定 (`slack_config` テーブル, Web UI「Slack」/ `/v1/admin/slack`)。
**DB 値が env より優先**。詳細は [slack.md](slack.md)。

| キー | 既定値 | 読み出し元 | 意味 |
|------|--------|-----------|------|
| `CONCORDIA_SLACK_ENABLED` | 空 (`1` で有効) | `slack/types.ts:19` | `1` のときだけ bot 起動 (DB 設定でも上書き可)。 |
| `CONCORDIA_SLACK_BOT_TOKEN` | 空 | `slack/types.ts:21` | Bot User OAuth Token (`xoxb-…`)。DB 設定が優先。 |
| `CONCORDIA_SLACK_APP_TOKEN` | 空 | `slack/types.ts:22` | App-Level Token (`xapp-…`, Socket Mode)。DB 設定が優先。 |
| `CONCORDIA_SLACK_CHANNEL_ID` | 空 | `slack/types.ts:23` | 運用チャンネル ID (`C…`)。DB 設定が優先。 |
| `CONCORDIA_SLACK_WORKING_IDLE_SEC` | `60` (最小 15) | `slack/bot.ts` | 「作業中」表示を消す無進捗秒数。 |
| `CONCORDIA_SECRET_KEY` | 空 → 鍵ファイル自動生成 | `shared/secret-box.ts` | DB 内 token を暗号化する secret-box のマスター鍵 (passphrase)。 空なら cwd の `concordia.secret.key` を自動生成して使用。 |

---

## 4. セッション管制 (spawn) / MCP delegation

詳細は [spawn.md](spawn.md)。

| キー | 既定値 | 読み出し元 | 意味 |
|------|--------|-----------|------|
| `CONCORDIA_SPAWN_TOKEN_PATH` | `<cwd>/.spawn.token` | `control/token.ts:21`, `mcp/delegation-server.ts:35` | spawn token ファイルの場所を上書き (docker/systemd で volume 分離する用)。 |
| `CONCORDIA_RESTART_DRY_RUN` | 未設定 (`1` で dry-run) | `app.ts:309` | `1` のとき `POST /v1/admin/restart` が spawn/exit を skip (テスト用)。 |

MCP サーバ (別プロセス) が読む env:

| キー | 既定値 | 読み出し元 | 意味 |
|------|--------|-----------|------|
| `CONCORDIA_BASE_URL` | `http://127.0.0.1:11111` | `mcp/core-server.ts:60`, `mcp/delegation-server.ts:51` | MCP サーバが叩く Concordia loopback URL。 |
| `CONCORDIA_MCP_FETCH_TIMEOUT_MS` | (実装値) | `mcp/core-server.ts:49` | core MCP server の fetch timeout。 |
| `VESTIGIUM_CATALOG_PATH` | `<cwd>/catalog/services.yaml` | `mcp/vestigium-server.ts:71` | vestigium MCP server が参照する service catalog。 |

---

## 5. observability (旧 Excubitor)

詳細は [observability.md](observability.md)。 observability は env を最小限しか持たず、 対象サービスは `catalog/services.yaml` (YAML 正本) で宣言する。

| キー | 既定値 | 読み出し元 | 意味 |
|------|--------|-----------|------|
| `LUDIARS_ROOT` | `E:/Document/Ars` | `observability/reviews/router.ts:10` | `/api/v1/reviews/*` が各リポの `review/` を探すルート。 |
| `CLAUDE_CODE_GIT_BASH_PATH` | 自動検出 (下記) | `observability/auto_fix/config.ts:12` | auto-fix が claude CLI を spawn する際の git-bash パス (Windows 必須)。 |
| `CLAUDE_CLI_PATH` | `claude` | `observability/auto_fix/config.ts:42` | claude CLI のフルパス or PATH 上のコマンド名。 |

`CLAUDE_CODE_GIT_BASH_PATH` 未設定時の Windows 自動検出順 (`auto_fix/config.ts:resolveBashPath()`):

1. `C:\Program Files\Git\bin\bash.exe`
2. `C:\Program Files (x86)\Git\bin\bash.exe`
3. SourceTree 同梱 (`%LOCALAPPDATA%\Atlassian\SourceTree\git_local\...`)
4. `%LOCALAPPDATA%\Programs\Git\bin\bash.exe`
5. `C:\msys64\usr\bin\bash.exe`
6. fallback: `C:\Program Files\Git\bin\bash.exe` (存在しなくても文字列返し → 起動時失敗ログ)

> 自動検出は **Git for Windows と SourceTree 同梱しか拾わない**。 別の bash を使う環境では env で明示すること (memory: feedback_concordia_bash_path)。

---

## 6. ログ

`src/shared/logger.ts` が読む。

| キー | 既定値 | 意味 |
|------|--------|------|
| `CONCORDIA_LOG_LEVEL` | `info` | pino のログレベル。 |
| `CONCORDIA_LOG_FILE` | 未設定 (`0` で無効) | dev 時 `logs/concordia.log` への file 追記を `0` で止める。 |
| `NODE_ENV` | 未設定 | `production` で pretty 出力と file target を無効化。 |

---

## 7. hook / worker ツール (別プロセス)

サービス本体ではなく、 各 AI セッションが起動する hook / worker スクリプトが読む env。 詳細は [`setup/hooks-claude-code.md`](hooks-claude-code.md) / [`setup/hooks-codex-cli.md`](hooks-codex-cli.md)。

`tools/concordia-hook.mjs`:

| キー | 既定値 | 意味 |
|------|--------|------|
| `CONCORDIA_HOOK` | 未設定 (`1` で opt-in) | `1` のセッションだけ hook が動く (sub-agent の自動登録防止)。 |
| `CONCORDIA_DISABLE` | 未設定 (`1` で no-op) | レガシー無効化フラグ。 |
| `CONCORDIA_URL` | `http://127.0.0.1:11111` | hook の送信先。 |
| `CONCORDIA_PROVIDER` | `claude-code` | provider 識別子。 |
| `CONCORDIA_TIMEOUT_MS` | `1500` | hook HTTP の timeout。 |

`tools/concordia-codex-worker.mjs`:

| キー | 既定値 | 意味 |
|------|--------|------|
| `CONCORDIA_URL` | `http://127.0.0.1:11111` | 送信先。 |
| `CODEX_BIN` | `codex` | codex CLI のバイナリ。 |
| `CONCORDIA_TIMEOUT_MS` | `1500` | HTTP timeout。 |

---

## 8. PR キュー / GitHub 同期

`src/pr/full-sync.ts` / `src/pr/reconcile.ts` が読む。 GitHub の PR キューを周期同期する。

| キー | 既定値 | 読み出し元 | 意味 |
|------|--------|-----------|------|
| `CONCORDIA_PR_FULL_SYNC_ENABLED` | 有効 (`0` で無効) | `pr/full-sync.ts:73` | 全 PR の周期フル同期。 |
| `CONCORDIA_PR_SYNC_OWNER` | `LUDIARS` | `pr/full-sync.ts:74` | 同期対象の GitHub org/owner。 |
| `CONCORDIA_PR_FULL_SYNC_MIN` | `15` (最小 2) | `pr/full-sync.ts:75` | フル同期の間隔 (分)。 |
| `CONCORDIA_PR_FULL_SYNC_LIMIT` | `300` (1..1000) | `pr/full-sync.ts:76` | 1 回で取得する PR 上限。 |
| `CONCORDIA_PR_RECONCILE_ENABLED` | 有効 (`0` で無効) | `pr/reconcile.ts:129` | open PR の差分 reconcile。 |
| `CONCORDIA_PR_RECONCILE_MIN` | `10` (最小 2) | `pr/reconcile.ts:130` | reconcile の間隔 (分)。 |

---

## 9. error 自動対応 / その他 runtime

| キー | 既定値 | 読み出し元 | 意味 |
|------|--------|-----------|------|
| `CONCORDIA_ERROR_AUTOFIX` | 未設定 (`1` で有効) | `control/error-fix.ts:80` | 検知した error task の自動 fix を有効化。 |
| `CONCORDIA_ERROR_AUTOFIX_CWD` | spawn default cwd | `control/error-fix.ts:81` | auto-fix を回す working directory。 |
| `CONCORDIA_ERROR_WATCH_LOGS_ROOT` | 未設定 | `discord/error-monitor.ts:25` | Discord エラー監視が tail するログのルート。 未設定なら監視 off。 |
| `CONCORDIA_ERROR_WATCH_INTERVAL_SEC` | `30` (最小 10) | `discord/error-monitor.ts:26` | エラー監視の tail 間隔 (秒)。 |
| `CONCORDIA_LOOP_MAX_CONSECUTIVE_FAILURES` | `5` | `shared/loop-bulkhead.ts` | 周期ループを個別停止するまでの連続失敗数。停止状態は `/health.halted_loops` と `error.reported` に出る。 |
| `CONCORDIA_EVENT_LOOP_LAG_ALERT_MS` | `200` | `metrics/loop.ts` | event-loop lag p99 の通知閾値 (ms)。 |
| `CONCORDIA_EVENT_LOOP_LAG_ALERT_SAMPLES` | `3` | `metrics/loop.ts` | lag 通知までに必要な連続超過サンプル数。 |
| `CONCORDIA_EVENT_LOOP_LAG_ALERT_COOLDOWN_MS` | `600000` | `metrics/loop.ts` | lag 通知の cooldown (ms)。 |
| `CONCORDIA_WORKSPACE_ROOT` | spawn default cwd を流用 | `shared/config.ts` | プライマリ workspace ルート (リアクションワークフロー / Work 走査の基点、 Memoria / Lictor の基点)。 未設定時は `CONCORDIA_SPAWN_DEFAULT_CWD` の解決値。 **設定 GUI (Rules ページ) / `/v1/admin/workspace-root(s)` から上書き可** (schema_meta 永続化、 bot restart で反映)。 |
| `CONCORDIA_WORKSPACE_ROOTS` | 未設定 (= `CONCORDIA_WORKSPACE_ROOT` のみ) | `shared/config.ts` | `;` 区切りの追加 workspace ルート列。 プライマリ + これらを正規化重複除去した集合が走査対象。 Work ページは全ルート直下の git リポを横断走査、 Memoria は実在する `<root>/Memoria` を採用。 |
| `CONCORDIA_GITHUB_ORG` | `LUDIARS` 運用パス存在時のみ `LUDIARS`、 他は空 | `shared/config.ts` | リポが属する GitHub Organization (PR / repo 操作の owner 解決)。 **設定 GUI / `/v1/admin/github-org` から上書き可** (schema_meta 永続化)。 |

> `workspace_root(s)` / `github_org` は AdminState (`schema_meta`) が source of truth で、 上記 env は
> 未設定時の既定値。 GUI / API で空に戻すと env 既定へフォールバックする。
> 複数ルートは `/v1/admin/workspace-roots` (GET/PUT、 `{ workspace_roots: string[] }`) で編集、
> 単一 `/v1/admin/workspace-root` (後方互換) は配列キーを `[value]` に上書きする。 先頭がプライマリ。

### 設定 GUI 専用 (env なし、 schema_meta 永続化)

以下は env を持たず、 設定ページ (Rules 由来の runtime 制御を含む) / `/v1/admin/*` からのみ設定する。

| 設定 | 既定 | API | 意味 |
|------|------|-----|------|
| reaction-workflow ON/OFF | env `CONCORDIA_REACTION_WORKFLOW` | `/v1/admin/reaction-workflow` | リアクションWF安全弁。 runner が live 評価 (即時反映)。 |
| reaction-workflow 発火ユーザ | 空 (全拒否) | env `CONCORDIA_REACTION_WORKFLOW_DISCORD_USERS` / `CONCORDIA_REACTION_WORKFLOW_SLACK_USERS` | プラットフォーム user ID のカンマ/空白/`;` 区切り allowlist。 |
| reaction 絵文字→アクション 上書き | (組み込み既定) | `/v1/admin/reaction-mappings` | ユーザ追加の写像。 既定より優先。 |
| `lictor_mode` | `auto` | `/v1/admin/lictor` | spawn の Lictor 起動。 `auto`=PATH の `lictor` / `dev`=`node <devPath>/bin/lictor.mjs` / `prod`=同梱 exe。 |
| `lictor_dev_path` | `<workspaceRoot>/Lictor` | 〃 | dev モードのローカル Lictor リポ。 |
| `lictor_prod_exe` | 空 | 〃 | prod モードの同梱 Lictor exe (Release 公開物) パス。 |
| `daily_token_budget` | `0` (無効) | `/v1/admin/cost-budget` | 日次トークン上限。 当日 (local 日) の消費合計が上限に達したら Concordia 発の命令 (新規 `spawn` / dispatcher 発話 / リアクションWF / rule engine・proposer) を止める。 消費量は `~/.claude/projects` と `~/.codex/sessions` の全ログを 2 分毎に走査し、 ファイル単位の累積トークンの増分を当日バケットに足し込む (= **登録外の外部バッチ・別ツール起動も合算**)。 GET は `today_tokens` / `blocked` も返す。 |

> PATH に `lictor` が無く spawn に失敗する環境は `lictor_mode=dev/prod` + パス指定で解決する。

---

## 関連

- [README.md](README.md) — 用途別インデックス + 最短起動
- [`spec/service-schema.md`](../interface/service-schema.md) — DB スキーマ / API 正本
- [`.env.example`](../../.env.example) — コメント付きサンプル (本表が最新値の正本)
