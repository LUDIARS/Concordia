---
type: setup
title: "Concordia 設定キー正本 (config-reference)"
description: "Concordia の全環境変数設定キーを集約した正本リファレンス。コア起動・LLM・Discord/Slack bot・セッション管制・observability・ログ・hook・PR キュー・error 自動対応・マルチ拠点連合の 10 カテゴリを網羅し、既定値・読み出し元ファイル・信頼境界ルールを明記する。"
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
  - federation.md
updated: 2026-08-20
---


# Concordia 設定キー正本 (config-reference)

最終更新: 2026-08-09

Concordia の **全 env 設定キー** をここに集約する。 各キーの「読み出し元 (src の実ファイル)」を根拠として明記しているので、 値の意味・既定値はこの表を正本とする。 用途別の設定手順は [`README.md`](README.md) の各ガイドを参照。

> **env 読み出しの実装配置**: 複数のモジュールが参照するキーは `src/config/` の設定レイヤー
> (`service-urls.ts` / `workspace-roots.ts` / `attachment-policy.ts` / `claude-availability.ts`、
> パース規則は `env-parse.ts`) が読み出しの正本。 消費側は `process.env` を直接見ずにここを経由する
> (同じキーを複数箇所が別々の既定値・別々の解釈で読んで割れるのを防ぐため)。
> 単一モジュールしか使わないキーは、 従来どおりそのモジュールが直接読んでよい。

設定の与え方は 2 通り:

- サービス cwd 直下の `.env` (起動時 `src/server.ts:loadDotEnv()` が読む。 `#` 始まりはコメント、 `KEY=VALUE`、 既存の `process.env` が優先)
- プロセス起動者が直接渡す環境変数 (systemd / Start-Process など)。 `.env` より優先される (loadDotEnv は `process.env[key] === undefined` のときだけ代入する)

---

## 1. コア (本体起動)

`src/shared/config.ts:loadConfig()` が読む。 ここが本体設定の正本。

| キー | 既定値 | 意味 |
|------|--------|------|
| `CONCORDIA_HOST` | `127.0.0.1` | bind するホスト。内部 API は loopback 専用で、非 loopback (0.0.0.0 / LAN IP 等) は起動拒否。下記「信頼境界」節参照。 |
| `CONCORDIA_PORT` | `11111` | backend HTTP ポート (loopback)。 |
| `CONCORDIA_DB_PATH` | 空 → `<cwd>/concordia.db` | SQLite ファイルパス。 空なら cwd 直下 (`defaultDbPath()`)。 |
| `CONCORDIA_LOST_AFTER_SEC` | `1800` (30 分) | heartbeat 途絶からこの秒数で `status=lost` に落とす。 |
| `CONCORDIA_ABANDONED_AFTER_SEC` | `86400` (24h) | lost からこの秒数で `abandoned`。 |
| `CONCORDIA_LOST_PURGE_AFTER_SEC` | `1800` | lost を purge するまでの猶予秒。 |
| `CONCORDIA_PURGE_AFTER_DAYS` | `90` | session_events の auto-purge 期間 (日)。 |
| `CONCORDIA_TRANSCRIPT_LOG_RETENTION_DAYS` | `7` | transcript_logs / session_messages の保持期間 (日)。 |
| `CONCORDIA_RULES_LOG_RETENTION_DAYS` | `7` | rules_log の保持期間 (日)。 |
| `CONCORDIA_SESSION_STATS_RETENTION_DAYS` | `7` | session_stats の保持期間 (日)。 |
| `CONCORDIA_SWEEPER_INTERVAL_MS` | `60000` (60 秒) | sweeper (lost/abandoned/purge 判定) の周期。 |
| `CONCORDIA_REAPER_ENABLED` | `1` | Lictor/agent-client process reaper。`0`で無効。 |
| `CONCORDIA_REAPER_INTERVAL_MS` | `300000` (5 分) | process reaperの走査周期。 |
| `CONCORDIA_REAPER_MIN_AGE_SEC` | `180` | 起動直後の登録競合を避ける最小process age。 |
| `CONCORDIA_REAPER_LOST_GRACE_SEC` | `300` | lost後、live trafficによる復帰を待ってからLictor treeを回収する猶予。 |
| `CONCORDIA_REAPER_SESSION_END_GRACE_SEC` | `300` | session-end 完了通知を待ってから ended session の残プロセスを保険回収するまでの猶予。 |
| `CONCORDIA_HTTP_CACHE_ENABLED` | 有効 | GET応答の小さなL1 cache。ルート別TTLはコード上の固定ポリシーとし、個別envは持たない。 |
| `CONCORDIA_REDIS_ENABLED` | 無効 | `1` のときだけ共有cache用Redisへ接続する。Redis不在環境では未設定のままにする。 |
| `CONCORDIA_MAX_AI_RULES` | `10` | AI proposer が新 rule を提案する上限。 enabled な ai 由来 rule がこれ以上なら proposer は claude を呼ばず skip (rule 雪だるま防止)。 |
| `CONCORDIA_SPAWN_DEFAULT_CWD` | 空 | 互換用の明示 project cwd。通常は request の `project` / `cwd` を使う。 |

> 注: `CONCORDIA_LOST_AFTER_SEC` の既定は **1800 秒 (30 分)** (`.env.example` も同値に統一済み)。 Stop hook が turn 毎にしか発火せず idle ≠ 終了のため、 これより短くすると健全な作業中セッションが lost 化しやすい。 過去に `.env.example` が 300 (5 分) を配布していた時期があるので、 運用中の実 env が 300 のままになっていないか確認すること。

### 旧 Excubitor テーブルの外部削除

通常起動は破壊的 DB 操作を行わず、削除用 env も読まない。全 Concordia プロセスと worker を停止後、まず dry-run で対象を確認する。

```powershell
npm run db:drop-obsolete-excubitor -- --db E:\path\to\concordia.db
```

適用時は未使用のバックアップパスと、停止済みであることの明示確認を必須とする。CLI はバックアップの `integrity_check` が成功してから旧テーブルを DROP し、VACUUM する。
長時間の DB 占有を日中に誤実行しないよう、`--apply` はサーバのローカル時刻で 23:00–05:00 に限定する。保守上やむを得ず日中に実行する場合に限り、`--allow-daytime` を追加して明示的に上書きする。

```powershell
npm run db:drop-obsolete-excubitor -- --db E:\path\to\concordia.db --backup E:\path\to\concordia.db.pre-excubitor-drop.bak --apply --confirm-services-stopped
```

### 信頼境界 (trust boundary)

Concordia の管理・変更 API (`/v1/admin/*`、`/v1/sweeper/run`、session inject/delete、
`/v1/delegation/invoke` 等) は **loopback (127.0.0.1) の内部 API**。サービス共有 bearer token は
主体を識別できず Web UI / MCP / worker 間の連携を壊すため廃止した。

- `shared/config.ts:isLoopbackHost()` で `127.0.0.0/8` / `::1` / `localhost` / 空だけを許可する。
  `0.0.0.0` / `::` / LAN IP / hostname は、token の有無にかかわらず起動拒否する。
- Web UI は外側の AccessControl を通過した管理者だけが利用する。Concordia 内部 API は Web の
  identity token を重ねて要求しない。
- Discord / Slack 起点の spawn・delegation は、Gateway / Socket Mode が認証した platform user ID を
  社員名簿 (`staff_members`) の役職と照合する (管理職以上)。ID 欠落・未登録・役職不足・判定関数の
  未注入は全拒否 ([staff-roster](../feature/staff-roster.md))。
- `/v1/spawn` の repository spawn token と、spawned session の一回限り enrollment は用途が異なるため維持する。

---

## 2. LLM (report / rule proposer / persona feedback)

| キー | 既定値 | 読み出し元 | 意味 |
|------|--------|-----------|------|
| `ANTHROPIC_API_KEY` | 空 | `config.ts:72`, `discord/webhook-pool.ts:127` | report 生成等で使う Anthropic API key。 空なら LLM 機能は無効。 |
| `CONCORDIA_REPORT_MODEL` | `claude-haiku-4-5` | `config.ts:73` | 終了レポート等の LLM モデル名。 |
| `CONCORDIA_DISABLE_CLAUDE` | 未設定 (`1` で緊急 OFF) | `config/claude-availability.ts` (消費: `report/generator.ts` / `report/summary-flags.ts` / `daily/generator.ts` / `api/library.ts`) | **緊急 hard-OFF**。 `1` で report / 日報 / summary flags / library 解析の claude CLI 呼び出しを止める。 通常の ON/OFF は下記の runtime スイッチで行い、 この env は `rules_enabled=true` でも勝つ。 |
| `CONCORDIA_CLAUDE_TIMEOUT_MS` | `120000` | `rules/claude-runner.ts:15` | rule 用 claude CLI subprocess の timeout (ms)。 |

> **runtime スイッチ (env ではない)**: chat 投稿 / rule engine の通常 ON/OFF は env ではなく
> `schema_meta` 永続のスイッチで制御する (再起動不要、 Web UI 設定ページ / admin API)。 **既定は OFF 寄り**。
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
| `CONCORDIA_DISCORD_FORUM_MODE` | 有効 (`0` で一時停止) | `discord/types.ts` | Phase 3 の Session / TaskWorkflow フォーラムレイアウト。未設定時は有効。既存カテゴリは自動作成せず、明示的な `0` は移行時のロールバック専用。 |
| `CONCORDIA_DISCORD_FORUM_WEBHOOK_NAME` | `Concordia` | `discord/bot.ts` | Forum の Cc システム投稿に使う webhook 表示名。Session 投稿は metadata `discord_webhook_name` で上書き可。 |
| `CONCORDIA_DISCORD_FORUM_WEBHOOK_AVATAR_URL` | 空 | `discord/bot.ts` | Forum の Cc システム投稿に使う webhook avatar URL。Session 投稿は metadata `discord_webhook_avatar_url` で上書き可。 |
| `CONCORDIA_DISCORD_COST_REFRESH_MIN` | `10` (最小 10) | `discord/bot.ts:157` | cost channel メッセージの更新間隔 (分)。 10 未満は 10 に丸め。 |
| `CONCORDIA_DISCORD_MONITOR_REFRESH_MIN` | `10` (最小 10) | `discord/bot.ts:182` | monitor (サービス状態) channel の更新間隔 (分)。 |
| `CONCORDIA_DISCORD_PR_QUEUE_REFRESH_MIN` | `15` (最小 10) | `discord/bot.ts:207` | PR キュー channel の更新間隔 (分)。 |
| `CONCORDIA_DISCORD_TEST_FORUM_RECONCILE_SEC` | `30` (最小 5、`0` で停止) | `discord/bot.ts` | Revisorの `Open / Test OK` 一覧とDiscord Test Forum投稿を同期する間隔 (秒)。 |

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
| `CONCORDIA_BASE_URL` | `http://127.0.0.1:11111` | `config/service-urls.ts` (消費: `mcp/core-server.ts`, `mcp/delegation-server.ts`) | MCP サーバが叩く Concordia loopback URL。 |
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

## 5.5 兄弟サービスの base URL

`src/config/service-urls.ts` が env 読み出しと従来互換の fallback URL の正本。
この helper 自体は catalog を照会しない。 **ポートの正本は Excubitor catalog** で
(port-source-rule)、 実効ポートを必要とする制御経路では
`excubitor/service-port.ts:resolveServicePort()` が観測値 → catalog の順で解決する。

| キー | 既定値 | 消費側 | 意味 |
|------|--------|--------|------|
| `CONCORDIA_EXCUBITOR_URL` | `http://127.0.0.1:17332` | `excubitor/client.ts`, `discord/bot.ts`, `discord/commands/excubitor.ts` | Excubitor (サービス監視・起動制御) の base URL。 |
| `EXCUBITOR_URL` | (同上) | 同上 | Excubitor 慣用キー。 `CONCORDIA_EXCUBITOR_URL` 未設定時のみ使う。 |
| `CONCORDIA_MEMORIA_URL` | `http://127.0.0.1:5180` | `memoria/client.ts`, `morning/scheduler.ts` | Memoria (タスク管理) の base URL。 |
| `ANATOMIA_BASE_URL` | `http://127.0.0.1:4200` | `harness/data-sufficiency.ts`, `harness/prompt-research.ts` | Anatomia (リポジトリ解析) の base URL。 |
| `THALEIA_BASE_URL` | `http://127.0.0.1:8890` | 同上 | Thaleia (ドキュメント / 仕様) の base URL。 |
| `CONCORDIA_PROMPT_RESEARCH_ANATOMIA_URL` | `ANATOMIA_BASE_URL` | `harness/prompt-research.ts` | prompt research だけ別の Anatomia を向ける上書き。 |
| `CONCORDIA_PROMPT_RESEARCH_THALEIA_URL` | `THALEIA_BASE_URL` | `harness/prompt-research.ts` | prompt research だけ別の Thaleia を向ける上書き。 |

いずれも空文字 / 空白のみは **未設定と同じ**扱い (既定へフォールバック)。 末尾スラッシュは除去される。

---

## 5.6 添付ファイルのパス許可

`src/config/attachment-policy.ts` が読み出しの正本。 chat 受信側 (`api/chat.ts`) と
Discord 送出側 (`discord/egress.ts`) が同じ設定を見ることを保証する
(入口と出口で許可ルートが割れると境界が破れるため)。 ルート文字列の分解は
`shared/attachment-paths.ts:buildAttachmentRoots()`。

| キー | 既定値 | 意味 |
|------|--------|------|
| `CONCORDIA_ATTACHMENT_ENFORCE` | 未設定 (= enforce ON。 `0` で audit のみ) | 許可外パスを実際に遮断するか。 `0` のときは拒否理由をログに残すだけで遮断しない。 |
| `CONCORDIA_ATTACHMENT_ROOTS` | 未設定 | workspace ルート + temp に **追加**する許可ルート (`;` 区切り)。 |

---

## 6. ログ

`src/shared/logger.ts` が読む。

| キー | 既定値 | 意味 |
|------|--------|------|
| `CONCORDIA_LOG_LEVEL` | `info` | pino のログレベル。 |
| `CONCORDIA_LOG_FILE` | 未設定 (`0` で無効) | dev 時 `logs/concordia.log` への file 追記を `0` で止める。 |
| `NODE_ENV` | 未設定 | `production` で pretty 出力と file target を無効化。 |

定常ログは、起動・停止・設定反映・reconcile の結果を `info`、処理失敗・状態不整合・rate limit を `warn/error` とする。投稿本文、正常系の API 受信/DB insert、message ごとの routing・skip・成功、webhook cache hit は記録しない。一時診断ログを追加する場合は追跡 Issue と撤去条件を併記する。

---

## 7. hook / worker ツール (別プロセス)

サービス本体ではなく、 各 AI セッションが起動する hook / worker スクリプトが読む env。 詳細は [`setup/hooks-claude-code.md`](hooks-claude-code.md) / [`setup/hooks-codex-cli.md`](hooks-codex-cli.md)。

Concordia の分離 worker:

| キー | 既定値 | 意味 |
|------|--------|------|
| `CONCORDIA_CHAT_MODE` | `embedded` | `worker` で core 内 Discord/Slack を止め、`npm run chat:worker` が SQLite read-model + 非同期 WS events を所有。lease 消失時は embedded mode なら自動復帰。`off` で無効。 |
| `CONCORDIA_WORKFLOW_MODE` | `embedded` | `worker` で delegation invoke を producer-only SQLite queue にし、`npm run workflow:worker` が消化。lease 消失時は embedded mode なら自動復帰。 |
| `CONCORDIA_COST_MODE` | `embedded` | `worker` で `npm run cost:worker` が cost sampling を所有。`off` で無効。 |

chat-worker は core 停止中の副作用 HTTP を `chat_mutation_outbox` に保存し、復旧後に
at-least-once 再送する。認証 token は outbox に保存せず、再送時に env から付与する。

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

Revisor の workflow token は環境変数ではなく、設定画面の「設定 > Revisor」
(`/v1/admin/revisor/config`) から `revisor_config.workflow_token_enc` へ暗号化保存する。
旧 `CONCORDIA_REVISOR_TOKEN` / `CONCORDIA_REVISOR_WORKFLOW_TOKEN` は読まれない。
loopback の読み取りは token 無しで動くが、レビュー投入・local PR の提出・マージ・再審査には
この DB 設定が必要になる。

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
| `CONCORDIA_WORKSPACE_ROOT` | `LUDIARS_ROOT`、次に明示 spawn cwd | `shared/config.ts` (プライマリ決定) / `config/workspace-roots.ts` (ルート集合) | プライマリ workspace ルート (リポジトリ探索の基点)。Session cwd には使用しない。 **設定 GUI (設定ページ) / `/v1/admin/workspace-root(s)` から上書き可**。 |
| `CONCORDIA_WORKSPACE_ROOTS` | 未設定 (= `CONCORDIA_WORKSPACE_ROOT` のみ) | `shared/config.ts` (プライマリ決定) / `config/workspace-roots.ts` (ルート集合) | `;` 区切りの追加 workspace ルート列。 プライマリ + これらを正規化重複除去した集合が走査対象。 Work ページは全ルート直下の git リポを横断走査、 Memoria は実在する `<root>/Memoria` を採用。 |
| `CONCORDIA_GITHUB_ORG` | `LUDIARS` 運用パス存在時のみ `LUDIARS`、 他は空 | `shared/config.ts` | リポが属する GitHub Organization (PR / repo 操作の owner 解決)。 **設定 GUI / `/v1/admin/github-org` から上書き可** (schema_meta 永続化)。 |

> `workspace_root(s)` / `github_org` は AdminState (`schema_meta`) が source of truth で、 上記 env は
> 未設定時の既定値。 GUI / API で空に戻すと env 既定へフォールバックする。
> 複数ルートは `/v1/admin/workspace-roots` (GET/PUT、 `{ workspace_roots: string[] }`) で編集、
> 単一 `/v1/admin/workspace-root` (後方互換) は配列キーを `[value]` に上書きする。 先頭がプライマリ。

### AdminState runtime 設定 (schema_meta 永続化)

以下は設定ページ (Rules 由来の runtime 制御を含む) / `/v1/admin/*` から設定する。
表の既定欄に env がある項目は、未永続化時だけその値を初期既定として使う。

| 設定 | 既定 | API | 意味 |
|------|------|-----|------|
| reaction-workflow ON/OFF | env `CONCORDIA_REACTION_WORKFLOW` | `/v1/admin/reaction-workflow` | リアクションWF安全弁。 runner が live 評価 (即時反映)。 |
| platform 権限ユーザ (reaction / spawn / delegation) | (AdminState には無い) | `/v1/staff` | **allowlist は廃止**。 誰が spawn / end-session / マージ / キルスイッチできるかは社員名簿 (`staff_members`) の役職で決まる (リアクションの発火自体は誰でも可) ([staff-roster](../feature/staff-roster.md))。 `PUT /v1/admin/reaction-workflow` は `{ enabled }` のみ受け、user ID 配列を送ると 400。 旧 env `CONCORDIA_REACTION_WORKFLOW_{DISCORD,SLACK}_USERS` と `*` 全員許可トークンは migration 44 で廃止 (旧 allowlist の ID は `manager` として名簿へ移行)。 |
| reaction 絵文字→アクション 上書き | (組み込み既定) | `/v1/admin/reaction-mappings` | ユーザ追加の写像。 既定より優先。 |
| `lictor_mode` | `auto` | `/v1/admin/lictor` | spawn の Lictor 起動。 `auto`=PATH の `lictor` / `dev`=`node <devPath>/bin/lictor.mjs` / `prod`=同梱 exe。 |
| `lictor_dev_path` | `<workspaceRoot>/Lictor` | 〃 | dev モードのローカル Lictor リポ。 |
| `lictor_prod_exe` | 空 | 〃 | prod モードの同梱 Lictor exe (Release 公開物) パス。 |
| `daily_token_budget` | `0` (無効) | `/v1/admin/cost-budget` | 日次トークン上限。 当日 (local 日) の消費合計が上限に達したら Concordia 発の命令 (新規 `spawn` / dispatcher 発話 / リアクションWF / rule engine・proposer) を止める。 消費量は `~/.claude/projects` と `~/.codex/sessions` の全ログを 2 分毎に走査し、 ファイル単位の累積トークンの増分を当日バケットに足し込む (= **登録外の外部バッチ・別ツール起動も合算**)。 GET は `today_tokens` / `blocked` も返す。 |

> PATH に `lictor` が無く spawn に失敗する環境は `lictor_mode=dev/prod` + パス指定で解決する。

`GET /v1/admin/reaction-workflow` の `readiness.status` は `disabled` / `ready` /
`no_authorized_users`。 発火自体は誰でもできる (`reaction_workflow` = ヒラ社員) ので、 件数は
**権限を要する指示 (🤝 spawn / 🔀 🚀 🔄 merge) を実行できる社員 = 管理職以上の人数**を数える。
ON かつ全 platform 合計 0 人は `no_authorized_users` として起動時・設定変更時に警告される
(押せはするが spawn も merge も起きない状態のため)。
platform 別の件数と issue code も返すが user ID 自体は返さない。名簿が空でも allow-all にはならず、
reaction workflow の ON/OFF にかかわらず platform 起点の spawn / delegation も拒否する
(判定関数が未注入の場合も deny = fail-closed)。

---

## 10. マルチ拠点連合 (federation)

`src/federation/env.ts` がフォールバックとして読む。ロール設定 API の DB 値が優先され、
本社 (listener) / 拠点 (client) とも既定 OFF の opt-in。手順は [federation.md](federation.md)、
設定解決は [federation-role-settings.md](../feature/federation-role-settings.md)、リンク設計は
[federation-link.md](../feature/federation-link.md)。

| キー | 既定値 | 読み出し元 | 意味 |
|------|--------|-----------|------|
| `CONCORDIA_FEDERATION_LISTEN` | 未設定 (`1` で有効) | `federation/env.ts:45` | 本社側の連合 listener を起動する。 `/v1` (11111) とは別ポート・別 origin。 |
| `CONCORDIA_FEDERATION_LISTEN_HOST` | `127.0.0.1` | `federation/env.ts:55` | listener の bind host。 外部拠点を受けるなら前段で TLS を終端する。 |
| `CONCORDIA_FEDERATION_LISTEN_PORT` | 既定なし (解決後の enabled=true なら必須) | `federation/env.ts:46` | listener port。 想定値 11112 は本リポの `excubitor.catalog.yaml` にコメントとして控えてあるだけで (fragment は service を宣言しない)、 割り当ての正本は `Excubitor/catalog/services.yaml`。 |
| `CONCORDIA_FEDERATION_HQ_URL` | 未設定 (= 拠点クライアントを起動しない) | `federation/env.ts:57` | 接続先本社の WS URL。 loopback 以外への平文 `ws://` は拠点側で拒否 (`wss://` を使う)。 |
| `CONCORDIA_FEDERATION_SITE_ID` | 未設定 | `federation/env.ts:58` | 本社の登録 ID (`[a-z0-9][a-z0-9-]{1,63}`)。 |
| `CONCORDIA_FEDERATION_SITE_TOKEN` | 未設定 | `federation/env.ts:59` | 登録応答でだけ得られる平文トークン。 secret store にのみ置き、 Git / ログには残さない。 |
| `CONCORDIA_FEDERATION_OUTBOX_MAX` | `10000` | `federation/env.ts:60` | 本社側で保持する拠点別 outbox (本社→拠点イベント) の上限行数 (超過は最古から破棄)。 |
| `CONCORDIA_FEDERATION_OUTBOX_TTL_SEC` | `604800` (7 日) | `federation/env.ts:61` | 同 outbox エントリの TTL 秒 (超過は破棄)。 |
| `CONCORDIA_VILLA_URL` | `http://127.0.0.1:17610` | `config/service-urls.ts` (消費: `villa/client.ts`) | 拠点タグ名の正本となる Villa の base URL。 到達不能なら拠点タグ無しで degrade する (部署ルーティングは継続)。 |

---

## 関連

- [README.md](README.md) — 用途別インデックス + 最短起動
- [`spec/service-schema.md`](../interface/service-schema.md) — DB スキーマ / API 正本
- [`.env.example`](../../.env.example) — コメント付きサンプル (本表が最新値の正本)
