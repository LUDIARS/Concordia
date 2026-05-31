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
| `CONCORDIA_HOST` | `127.0.0.1` | bind するホスト。 loopback 前提 (認証なし)。 |
| `CONCORDIA_PORT` | `17330` | backend HTTP ポート (loopback)。 |
| `CONCORDIA_DB_PATH` | 空 → `<cwd>/concordia.db` | SQLite ファイルパス。 空なら cwd 直下 (`defaultDbPath()`)。 |
| `CONCORDIA_LOST_AFTER_SEC` | `1800` (30 分) | heartbeat 途絶からこの秒数で `status=lost` に落とす。 |
| `CONCORDIA_ABANDONED_AFTER_SEC` | `86400` (24h) | lost からこの秒数で `abandoned`。 |
| `CONCORDIA_LOST_PURGE_AFTER_SEC` | `1800` | lost を purge するまでの猶予秒。 |
| `CONCORDIA_PURGE_AFTER_DAYS` | `90` | session_events の auto-purge 期間 (日)。 |
| `CONCORDIA_SWEEPER_INTERVAL_MS` | `60000` (60 秒) | sweeper (lost/abandoned/purge 判定) の周期。 |
| `CONCORDIA_MAX_AI_RULES` | `10` | AI proposer が新 rule を提案する上限。 enabled な ai 由来 rule がこれ以上なら proposer は claude を呼ばず skip (rule 雪だるま防止)。 |
| `CONCORDIA_SPAWN_DEFAULT_CWD` | 空 (Win + `E:\Document\Ars` 存在時は自動採用) | `/v1/spawn` / `/v1/admin/spawn-session` で `cwd` 省略時の既定。 解決順は [spawn ガイド](spawn.md) 参照。 |

> 注: `.env.example` の `CONCORDIA_LOST_AFTER_SEC` コメントは「default 5 分」 だが、 実コードの既定は **1800 秒 (30 分)**。 Stop hook が turn 毎に発火する制約で idle ≠ 終了のため延長された (`config.ts:67` のコメント)。

---

## 2. LLM (report / rule proposer / persona feedback)

| キー | 既定値 | 読み出し元 | 意味 |
|------|--------|-----------|------|
| `ANTHROPIC_API_KEY` | 空 | `config.ts:72`, `discord/webhook-pool.ts:127` | report 生成等で使う Anthropic API key。 空なら LLM 機能は無効。 |
| `CONCORDIA_REPORT_MODEL` | `claude-haiku-4-5` | `config.ts:73` | 終了レポート等の LLM モデル名。 |
| `CONCORDIA_DISABLE_CLAUDE` | 未設定 (`1` で無効化) | `server.ts:228,237` / `rules/proposer.ts` / `report/generator.ts` / `daily/generator.ts` / `personas/feedback.ts` | `1` で rule engine / proposer / report 等の claude CLI 呼び出しを全て止める。 |
| `CONCORDIA_CLAUDE_TIMEOUT_MS` | `120000` | `rules/claude-runner.ts:15` | rule 用 claude CLI subprocess の timeout (ms)。 |

---

## 3. Discord bot

`src/discord/types.ts:readDiscordEnv()` と `src/discord/bot.ts` が読む。 詳細は [discord.md](discord.md)。

| キー | 既定値 | 読み出し元 | 意味 |
|------|--------|-----------|------|
| `CONCORDIA_DISCORD_ENABLED` | 空 (`1` で有効) | `discord/types.ts:35` | `1` のときだけ bot 起動。 それ以外は完全 no-op。 |
| `CONCORDIA_DISCORD_TOKEN` | 空 | `discord/types.ts:36` | Bot token。 未設定なら起動 skip。 |
| `CONCORDIA_DISCORD_GUILD_ID` | 空 | `discord/types.ts:37` | 招待先 guild (server) ID。 未設定なら起動 skip。 |
| `CONCORDIA_DISCORD_APPLICATION_ID` | 空 | `discord/types.ts:38` | slash command 登録に使う Application ID。 未設定だと bot は起動するが slash command が未登録 (warn ログ)。 |
| `CONCORDIA_DISCORD_COST_REFRESH_MIN` | `10` (最小 10) | `discord/bot.ts:119` | cost channel メッセージの更新間隔 (分)。 10 未満は 10 に丸め。 |
| `CONCORDIA_DISCORD_TRANSCRIPT_LOG_MAX` | `1200` | `discord/egress.ts:216` | transcript ログ転送の最大件数。 |

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
| `CONCORDIA_BASE_URL` | `http://127.0.0.1:17330` | `mcp/core-server.ts:60`, `mcp/delegation-server.ts:51` | MCP サーバが叩く Concordia loopback URL。 |
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

サービス本体ではなく、 各 AI セッションが起動する hook / worker スクリプトが読む env。 詳細は [`docs/hooks-claude-code.md`](../../docs/hooks-claude-code.md) / [`docs/hooks-codex-cli.md`](../../docs/hooks-codex-cli.md)。

`tools/concordia-hook.mjs`:

| キー | 既定値 | 意味 |
|------|--------|------|
| `CONCORDIA_HOOK` | 未設定 (`1` で opt-in) | `1` のセッションだけ hook が動く (sub-agent の自動登録防止)。 |
| `CONCORDIA_DISABLE` | 未設定 (`1` で no-op) | レガシー無効化フラグ。 |
| `CONCORDIA_URL` | `http://127.0.0.1:17330` | hook の送信先。 |
| `CONCORDIA_PROVIDER` | `claude-code` | provider 識別子。 |
| `CONCORDIA_TIMEOUT_MS` | `1500` | hook HTTP の timeout。 |

`tools/concordia-codex-worker.mjs`:

| キー | 既定値 | 意味 |
|------|--------|------|
| `CONCORDIA_URL` | `http://127.0.0.1:17330` | 送信先。 |
| `CODEX_BIN` | `codex` | codex CLI のバイナリ。 |
| `CONCORDIA_TIMEOUT_MS` | `1500` | HTTP timeout。 |

---

## 関連

- [README.md](README.md) — 用途別インデックス + 最短起動
- [`spec/service-schema.md`](../interface/service-schema.md) — DB スキーマ / API 正本
- [`.env.example`](../../.env.example) — コメント付きサンプル (本表が最新値の正本)
