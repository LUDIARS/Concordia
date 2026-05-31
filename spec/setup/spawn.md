# セッション管制 (spawn) の設定 (spawn)

## 目的

Concordia から新しい lictor-wrapped な Claude Code / Codex / Gemini セッションを **Windows Terminal の tab / window** として起動する (管制 spawn)。 Web UI / Discord `/spawn` / MCP delegation から呼ぶ。 spawn 本体 (`src/control/spawner.ts`) は `wt.exe` ランチャを使うため **Windows 専用**。

## エンドポイントは 2 系統

| エンドポイント | 認証 | 用途 |
|----------------|------|------|
| `POST /v1/spawn` | **Bearer token** (`.spawn.token`) | 外部 / Discord bot から。 token 必須。 |
| `POST /v1/admin/spawn-session` | 無し (loopback 信頼境界) | Web UI / dashboard から。 他の `/v1/admin/*` と同じ扱い。 |

`/v1/spawn` の token は `<cwd>/.spawn.token` (64-hex)。 Concordia が起動時に未生成なら自動生成する (`ensureSpawnToken`, `src/control/token.ts`)。 認証は `Authorization: Bearer <token>` または `X-Concordia-Token: <token>`。 `GET /v1/spawn/info` (無認証) で token ファイルの絶対パスだけ取得できる (値は返さない)。

provider は `claude` / `codex` / `gemini`、 mode は `tab` (既定) / `window`。

## 設定キー

正本は [`config-reference.md` §4](config-reference.md#4-セッション管制-spawn--mcp-delegation)。

| キー | 既定値 | 意味 |
|------|--------|------|
| `CONCORDIA_SPAWN_DEFAULT_CWD` | 空 (自動既定あり) | `cwd` 省略時に使う working directory。 |
| `CONCORDIA_SPAWN_TOKEN_PATH` | `<cwd>/.spawn.token` | token ファイルの場所を上書き (docker/systemd の volume 分離用)。 |
| `CONCORDIA_RESTART_DRY_RUN` | 未設定 | `1` で `/v1/admin/restart` の spawn/exit を skip (テスト用)。 |

### CONCORDIA_SPAWN_DEFAULT_CWD の解決順

`body.cwd` が省略されたときの既定値 (`src/shared/config.ts` / `src/api/spawn.ts`):

1. env `CONCORDIA_SPAWN_DEFAULT_CWD` (明示指定、 最優先)
2. Windows かつ `E:\Document\Ars` が存在すればその値 (LUDIARS 運用既定の自動採用)
3. 空 → フォールバック無し (Concordia 自身の cwd で spawn)

> LUDIARS の Windows 機ではほぼ常に (2) が効くので、 別パスに変えたいときだけ env を設定する。 Concordia への委託は cwd 明示が安全 (memory: feedback_delegation_cwd_needed)。

## MCP delegation 経由の spawn

`concordia-delegation` MCP server (`dist/mcp/delegation-server.js`) からも委託 spawn できる。 別プロセスなので env で Concordia を指す:

| キー | 既定値 | 意味 |
|------|--------|------|
| `CONCORDIA_BASE_URL` | `http://127.0.0.1:17330` | 叩く先。 |
| `CONCORDIA_SPAWN_TOKEN_PATH` | `<cwd>/.spawn.token` | `/v1/spawn` 用 token の場所。 |

MCP 登録例はリポ root [`README.md`](../../README.md) の MCP サーバ節。 委託テンプレ自体の設計は [`spec/delegation.md`](../feature/delegation.md)。

## 手順

1. Concordia を起動 ([core.md](core.md))。 起動時に `.spawn.token` が生成される (ログ: `spawn endpoint enabled` + tokenPath)。
2. 必要なら `CONCORDIA_SPAWN_DEFAULT_CWD` を設定 (上記)。
3. 呼び出し:
   - Web UI: `POST /v1/admin/spawn-session` (token 不要)
   - 外部 / bot: `GET /v1/spawn/info` で token パスを得て読み、 `POST /v1/spawn` に Bearer 付与
   - Discord: `/spawn provider [cwd]` (bot が in-process で token を直読み)
4. spawn 履歴は `GET /v1/spawn/recent` (直近 50 件、 in-memory)。

## 注意点

- **Windows 専用**: `wt.exe` 起動なので非 Windows では spawn できない (`GET /v1/spawn/info` の `platform_supported` が false)。
- **token は機密**: `.spawn.token` は cwd 直下。 `.gitignore` 済。 値を共有しない。 壊れた (64-hex でない) ファイルは自動 rotate される。
- **`/v1/admin/spawn-session` は loopback 前提**: 認証なしは「127.0.0.1 でしか上がっていない」 信頼境界に依存。 非 loopback に晒さない。
- **Tauri / window 起動の落とし穴**: lictor-wrapped GUI を起動するケースでは、 親終了で window が落ちる問題に注意 (memory: feedback_tauri_launch_powershell)。

## トラブルシュート

| 症状 | 対処 |
|------|------|
| `/v1/spawn` が "missing or invalid token" | `.spawn.token` 未生成 / 値不一致。 本体起動と cwd を確認。 |
| `/spawn` (Discord) が "token not found" | Concordia 未起動 or token ファイルが別 cwd。 |
| spawn が cwd 違いで開く | `CONCORDIA_SPAWN_DEFAULT_CWD` か呼び出しの `cwd` を明示。 |
| 非 Windows で spawn 不可 | 仕様 (wt.exe 専用)。 |

## 関連

- [`spec/delegation.md`](../feature/delegation.md) — 委託テンプレ設計
- [discord.md](discord.md) — `/spawn` slash command
- [config-reference.md](config-reference.md) — 全キー正本
