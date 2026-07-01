---
type: setup
title: "observability (旧 Excubitor) を有効にするための設定 (observability)"
description: "LUDIARS 各サービスの起動状態・git・package version の周期スキャン、ログ tail + エラー検知、error task の auto-fix / investigate を行う Concordia の observability レイヤー。旧 Excubitor を `src/observability/` に集約したもので、backend 起動時に `bootObservability()` で自動的に立ち上がる。監視対象は `catalog/services.yaml` で宣言し、file watch による自動 re-sync に対応。"
service: concordia
domain: observability
tags:
  - typescript
  - monitoring
  - auto-fix
  - claude
  - rest-api
  - spawn
  - polling
  - lifecycle
status: implemented
related:
  - ../setup/windows.md
  - ../setup/config-reference.md
  - ../setup/core.md
updated: 2026-06-30
---


# observability (旧 Excubitor) を有効にするための設定 (observability)

## 目的

LUDIARS 各サービスの起動状態 / git / package version の周期スキャン、 ログ tail + エラー検知、 error task の auto-fix / investigate を行う。 旧 Excubitor を Concordia `src/observability/` に集約したもの (memory: project_concordia_absorbs_excubitor)。

observability は backend 起動時に `bootObservability()` で自動的に立ち上がる (`src/server.ts:174`)。 **専用の有効化 env フラグは無い** — 起動すれば走る。 失敗しても本体は止めず warn して継続する。 「何を監視するか」 は env ではなく **`catalog/services.yaml`** (YAML 正本) で宣言する。

## 設定の正本: catalog/services.yaml

監視対象は env ではなく `catalog/services.yaml` で定義する (`src/observability/catalog/loader.ts` が読み込み、 file watch で再 sync)。 1 サービス = 1 エントリ。 実在するフィールド (catalog 実物より):

| フィールド | 意味 |
|-----------|------|
| `code` / `name` / `project_code` / `component` | 識別。 `code` が API パスのキー (`/api/v1/services/:code`)。 |
| `port` | listen port。 |
| `repo` | `org/Repo`。 |
| `runtime` | `docker-compose` / `dev-process-md` / `node` 等。 |
| `compose_file` / `services` / `container_names` | docker-compose runtime 用。 |
| `monitor_only` | `true` なら監視のみ (制御しない)。 共有インフラ用。 |
| `autostart` | 起動時に自動 start するか。 |
| `health` | `{ type, url, interval_sec }` health probe。 |
| `infisical` | `{ project_id, environment, inject }` 秘密注入設定。 |
| `auto_fix` | `{ enabled, agent, max_auto_attempts, working_dir, branch_prefix, create_pr, pr_draft }`。 `enabled: false` のサービスは auto-fix 対象外。 |

> 各サービスが Infisical を自前 fetch する方針なので、 observability 層は共有 service-credential を持たない (memory: project_concordia_absorbs_excubitor)。

## 設定キー (env)

observability が読む env は少ない。 正本は [`config-reference.md` §5](config-reference.md#5-observability-旧-excubitor)。

| キー | 既定値 | 意味 |
|------|--------|------|
| `LUDIARS_ROOT` | `E:/Document/Ars` | `/api/v1/reviews/*` が各リポの `review/` を探すルート (`reviews/router.ts:10`)。 |
| `CLAUDE_CODE_GIT_BASH_PATH` | 自動検出 | auto-fix が claude CLI を spawn する git-bash パス ([windows.md](windows.md))。 |
| `CLAUDE_CLI_PATH` | `claude` | claude CLI のパス / コマンド名 (`auto_fix/config.ts:42`)。 |
| `VESTIGIUM_CATALOG_PATH` | `<cwd>/catalog/services.yaml` | vestigium MCP server が参照する catalog (別プロセス)。 |

auto-fix のその他パラメータ (timeout 等) は env ではなく **コード定数** (`auto_fix/config.ts`): `promptMaxChars=16000` / `cliTimeoutMs=10min` / `verifyTimeoutMs=90s`。 env では変更できない。

## 手順

1. `catalog/services.yaml` に監視対象を記述 (既に LUDIARS 全サービス分が入っている)。 新サービス追加は同ファイルに 1 エントリ足す → file watch で自動再 sync。
2. auto-fix を使うサービスは `auto_fix.enabled: true` + `working_dir` / `branch_prefix` 等を設定。
3. Windows で auto-fix を回すなら `CLAUDE_CODE_GIT_BASH_PATH` / `CLAUDE_CLI_PATH` を確認 ([windows.md](windows.md))。
4. Concordia を起動 ([core.md](core.md))。 ログに `observability layer booted` が出れば成功 (`server.ts:175`)。

## 起動時に走るもの

`bootObservability()` (`src/observability/index.ts`):

- catalog 読み込み → DB sync
- default error rules seed
- process bridge (spawn 子の stdout を log bus へ)
- file tail + error detector (パターン検知 → `error_tasks` 投入)
- scanner loop (docker / git / package version 周期スキャン)
- catalog watcher (`catalog/services.yaml` 変更検知で再 sync)
- autostart 実行
- HTTP router を `app.ts` にマウント (`/api/v1/services`, `/error-tasks`, `/auto-fix/runs`, `/error-rules`, `/api/v1/reviews/*` 等)

## API (抜粋)

| エンドポイント | 用途 |
|----------------|------|
| `GET /api/v1/services` | 全サービスの状態一覧。 |
| `GET /api/v1/services/:code/logs/recent` | 直近ログ。 |
| `GET /api/v1/error-tasks?state=` | 検知された error task。 |
| `POST /api/v1/error-tasks/:id/auto-fix` | auto-fix 実行 (`auto_fix.enabled` が前提)。 |
| `POST /api/v1/error-tasks/:id/investigate` | 調査のみ。 |
| `GET /api/v1/reviews/*` | `LUDIARS_ROOT` 下の各リポ `review/` を横断閲覧 (skill `ludiars-review` が書き出す)。 |

triage 系 PATCH は `x-concordia-actor` (後方互換で `x-excubitor-actor` も受ける) ヘッダで actor を記録。

## トラブルシュート

| 症状 | 対処 |
|------|------|
| `observability layer boot failed` warn | catalog 読み込み失敗の可能性。 `catalog/services.yaml` の YAML を確認。 本体は継続する。 |
| auto-fix が動かない | 対象サービスの `auto_fix.enabled: false`、 または claude CLI / bash パス未設定。 |
| reviews が空 | `LUDIARS_ROOT` が違う or 各リポに `review/<date>/` が無い (skill `ludiars-review` 未実行)。 |

## 関連

- [windows.md](windows.md) — auto-fix の git-bash / CLI パス
- [config-reference.md](config-reference.md) — 全キー正本
- `catalog/services.yaml` — 監視対象の正本
