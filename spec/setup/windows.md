---
type: setup
title: "Windows で起動するための設定 (windows)"
description: "Concordia を Windows で安定起動させるための設定ガイド。git-bash パス解決 (CLAUDE_CODE_GIT_BASH_PATH) と loopback port 11111 の Windows 固有の落とし穴、dev/production 起動手順、トラブルシュートをまとめる。"
service: concordia
domain: tooling
tags:
  - typescript
  - spawn
  - windows
  - claude
  - lifecycle
  - monitoring
  - auto-fix
  - setup
status: implemented
related:
  - ../setup/core.md
  - ../setup/observability.md
  - ../setup/config-reference.md
updated: 2026-06-30
---


# Windows で起動するための設定 (windows)

## 目的

Concordia を Windows で安定起動させる。 Concordia は内部で claude CLI を child process spawn する場面 (rule engine / proposer / observability auto-fix / report) があり、 そこで **git-bash のパス**が必要になる。 また loopback port にいくつか Windows 固有の落とし穴がある。

## 設定キー

| キー | 既定値 | 意味 |
|------|--------|------|
| `CLAUDE_CODE_GIT_BASH_PATH` | 自動検出 | claude CLI が child spawn で要求する git-bash の実体パス。 |
| `CLAUDE_CLI_PATH` | `claude` | claude CLI 本体のパス or コマンド名 (observability auto-fix 用)。 |

両方とも observability の `src/observability/auto_fix/config.ts` が読む。 値の正本は [`config-reference.md` §5](config-reference.md#5-observability-旧-excubitor)。

## CLAUDE_CODE_GIT_BASH_PATH

`auto_fix/config.ts:resolveBashPath()` は env が未設定なら以下を**順に**試す:

1. `C:\Program Files\Git\bin\bash.exe`
2. `C:\Program Files (x86)\Git\bin\bash.exe`
3. SourceTree 同梱 (`%LOCALAPPDATA%\Atlassian\SourceTree\git_local\...` / OneDrive ドキュメント配下)
4. `%LOCALAPPDATA%\Programs\Git\bin\bash.exe`
5. `C:\msys64\usr\bin\bash.exe`
6. fallback: `C:\Program Files\Git\bin\bash.exe` (見つからなくても文字列を返すので、 起動時に失敗ログになる)

つまり **自動検出が拾うのは Git for Windows と SourceTree 同梱だけ**。 これ以外の bash (WSL、 任意パスの msys2 等) を使う環境では env で明示する必要がある。

```bash
# .env もしくは環境変数で
CLAUDE_CODE_GIT_BASH_PATH=C:\Program Files\Git\bin\bash.exe
```

> これは Concordia 全体で繰り返し踏んでいる既知事項 (memory: feedback_concordia_bash_path / feedback_claude_cli_windows_bash)。 未設定だと spawn 系が exit 1 になる。 Concordia を `claude` / `codex` 等から spawn する場合 (Lictor ラップ含む) は特に明示推奨。

## port 事情 (11111 loopback)

Concordia は `127.0.0.1:11111` で listen する (`CONCORDIA_PORT`)。 LUDIARS の port 運用上の注意:

- **11111 は Concordia 専有 (loopback)**。 旧 Excubitor が使っていた **10101 / 17332 は機能統合に伴い空き** になっている (Excubitor は Concordia に吸収済 — memory: project_concordia_absorbs_excubitor)。 古い設定でそれらを掴むものは無い。
- Windows の **TCP dynamic port range が広すぎると** loopback でも RST が返ることがある (memory: feedback_windows_tcp_dynamic_port_range)。 11111 が不可解に listen 失敗するときは `netsh int ipv4 show dynamicport tcp` を確認し、 ephemeral 範囲を既定 (49152 起点) に戻す。
- port 衝突時は古い node プロセスを kill する (`Stop-Process`) か `CONCORDIA_PORT` を変える。

## dev / production 起動 (Windows)

```powershell
# dev (Vite + backend)
npm run dev
# backend 単体
npm run dev:backend
```

restart endpoint (`POST /v1/admin/restart`) は実行形態で挙動が分かれる:

- **`node --watch` 配下 (dev:backend / Excubitor 管理の標準形)**: entry ファイル (`src/server.ts`) の mtime を touch し、 **watcher 自身に in-place 再起動させる**。 detached spawn はしない — 旧 watch supervisor が生き残ったまま新ツリーを立てると supervisor が二重化し、 以後ファイル変更のたびに port 11111 を取り合う EADDRINUSE クラッシュループになるため (2026-07-02 障害)。 watch 検出は watch 子プロセス固有の IPC channel + `WATCH_REPORT_DEPENDENCIES` env。
- **非 watch (`node dist/server.js` 等)**: 従来通り `npm run dev:backend` を detached spawn して自分は exit する。 `npm.cmd` を明示指定するので PATH に npm がある前提 (shell 経由はしない)。

テスト時は `CONCORDIA_RESTART_DRY_RUN=1` で restart 副作用を skip できる。

## トラブルシュート

| 症状 | 対処 |
|------|------|
| spawn 系が exit 1 / `bash` 見つからない | `CLAUDE_CODE_GIT_BASH_PATH` を実体パスで明示。 |
| auto-fix が claude を起動できない | `CLAUDE_CLI_PATH` を確認 (PATH に `claude` が無いならフルパス指定)。 |
| 11111 が listen できない | 古い node を kill、 または dynamic port range を確認 (上記)。 |
| `bash.exe.stackdump` が cwd に出る | git-bash 子プロセスのクラッシュ痕跡。 bash パスが不正 / 壊れている可能性。 正しい bash を指す。 |

## 関連

- [core.md](core.md) — 本体起動の一般手順
- [observability.md](observability.md) — auto-fix (bash path を使う主機能)
- [config-reference.md](config-reference.md) — 全キー正本
