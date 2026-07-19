---
type: setup
title: "セッション管制 (spawn) の設定 (spawn)"
description: "Concordia から Claude Code / Codex / Gemini セッションを Windows Terminal タブ/ウィンドウとして起動するスポーン機能の設定ガイド。Bearer token 認証の外部エンドポイント (`/v1/spawn`) と loopback 信頼境界の管理エンドポイント (`/v1/admin/spawn-session`) の 2 系統を解説し、MCP delegation 経由の委託 spawn と既定 cwd の解決順も網羅する。"
service: concordia
domain: session-coordination
tags:
  - typescript
  - spawn
  - lifecycle
  - delegation
  - auth
  - llm
  - claude
  - codex
  - gemini
status: implemented
related:
  - ../feature/delegation.md
  - discord.md
  - config-reference.md
updated: 2026-07-19
---

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
| `CONCORDIA_SPAWN_DEFAULT_CWD` | 空 | 互換用の明示 project cwd。workspace root と同じ値は拒否される。 |
| `CONCORDIA_SPAWN_TOKEN_PATH` | `<cwd>/.spawn.token` | token ファイルの場所を上書き (docker/systemd の volume 分離用)。 |
| `CONCORDIA_RESTART_DRY_RUN` | 未設定 | `1` で `/v1/admin/restart` の spawn/exit を skip (テスト用)。 |

### spawn cwd の必須条件

Session spawn は個別 project cwd を必須とする。`cwd` / `project` / template の `default_cwd` のいずれでも project を解決できない場合は 400 で停止する。`workspaceRoots` のいずれかと完全一致する Castra/workspace root は中央 spawn guard が拒否する。

`getWorkspaceRoot()` 自体の解決順 (`src/admin/state.ts` / `src/shared/config.ts`):

1. AdminState の `workspace_roots` (設定 GUI / API で上書き、 schema_meta 永続化) の先頭
2. (移行用) 旧 single key `workspace_root`
3. project を解決できなければ spawn せず、呼び出し元がユーザへ project を確認する
4. 空 → フォールバック無し (Concordia 自身の cwd で spawn)

> `workspaceRoots` はリポジトリ探索の正本であり、Session cwd の既定値ではない。Castra 直下へ Session を起動してから project を探す運用は禁止。

### worktree の project別 Skill / Memory / trust 設定

branch 指定で linked worktree を作成または再利用するとき、Cc は Lictor 起動前に
project 本体から不足している `.claude` / `.agent` / `.agents` / `.codex` と
`.mcp.json` / `mcp.json` / `mcp_servers.json` を worktree へコピーする。これにより、
ignored な `settings.local.json`、hook、Skill、MCP 定義が worktree に無いことを原因とする
初回 trust ダイアログを防ぐ。

Skill はproject本体の `.claude/skills` / `.agent(s)/skills` / `.codex/skills` を正本とし、
workspace共通Skillと他projectのSkillを混ぜない。Memoryはリポジトリへ入れず、Claudeの
`~/.claude/projects/<project本体の絶対path key>/memory/*.md` だけを、対応する
`<worktreeの絶対path key>/memory/` へ不足分のみ配置する。workspace rootの混在Memoryや
他projectのMemoryはコピーしない。

worktree 側に既にある設定・Memoryは上書きしない。project内の `.claude/memory`、
`state` / `worktrees` / `sessions` / `logs` / cache / temp と symlink は、private Memory、
実行時データ、または境界外参照なのでproject設定コピーの対象にしない。コピーに失敗した
場合は spawn を中止し、新規作成直後なら worktree と新規 local branch を片付ける。

### spawn 後の Session 作業ポリシー Inject

Concordia が interactive session を spawn するときは、Lictor 子プロセスへ一意な
`CONCORDIA_SPAWN_ID` と `CONCORDIA_SPAWN_CWD_MODE` (`provided` / `omitted`) を渡す。
Lictor はこの二項目を session 登録 metadata に返し、Concordia は新規登録された当該
session だけへ、project 特定、workspace root 禁止、branch 確認・Cc 登録、PR で停止、
明示指示のないテスト・merge 禁止を含む共通 `session.inject` を必ず送る。

照合は cwd と時刻の推測ではなく spawn ID で行うため、同一 cwd で複数 session を並走
起動しても別 session に指示を送らない。既存 session の再登録時には再 Inject しない。

## MCP delegation 経由の spawn

`concordia-delegation` MCP server (`dist/mcp/delegation-server.js`) からも委託 spawn できる。 別プロセスなので env で Concordia を指す:

| キー | 既定値 | 意味 |
|------|--------|------|
| `CONCORDIA_BASE_URL` | `http://127.0.0.1:11111` | 叩く先。 |
| `CONCORDIA_SPAWN_TOKEN_PATH` | `<cwd>/.spawn.token` | `/v1/spawn` 用 token の場所。 |

MCP 登録例はリポ root [`README.md`](../../README.md) の MCP サーバ節。 委託テンプレ自体の設計は [`spec/delegation.md`](../feature/delegation.md)。

## 手順

1. Concordia を起動 ([core.md](core.md))。 起動時に `.spawn.token` が生成される (ログ: `spawn endpoint enabled` + tokenPath)。
2. 必要なら `CONCORDIA_SPAWN_DEFAULT_CWD` を設定 (上記)。
3. 呼び出し:
   - Web UI: `POST /v1/admin/spawn-session` (token 不要)
   - 外部 / bot: `GET /v1/spawn/info` で token パスを得て読み、 `POST /v1/spawn` に Bearer 付与
   - Discord: `/spawn provider [cwd]` (bot が in-process で token を直読み)
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
