---
task: spawn-target-worktree-retry
project: Concordia
kind: 実装
status: done
created: 2026-09-01T00:00:00.000Z
source_session: 628a741e-b39c-4845-8e50-8da75b26ea83
memoria_task_id: 1811
memory_links:
  - Memoria #1723
  - Memoria #1739
  - Memoria #1764
---

# Windows の一過性 worktree 作成失敗を再試行する

## 要件: SPEC-SPAWN-TARGET-WORKTREE-RETRY

## 目的

Windows で `git worktree add` が EPERM / EBUSY、Permission denied、resource busy のような
一過性ファイルロック競合で失敗しても、spawn を即時失敗にせず有限回だけ再試行する。

## 症状と原因

`prepareSpawnTarget` は worktree 作成の Git 実行を一度だけ試し、失敗をそのまま
`failed to create worktree` として返していた。ウイルス対策や Explorer 等との短い競合でも
spawn が失敗していた。

## 対策

`src/control/retry-transient-git-error.ts` で対象エラーだけを識別し、既定 3 回、300ms と
900ms の待機で再試行する。対象外エラーは即時に返し、上限到達時は最後の Git エラーを保持する。

## 完了条件

- [x] worktree 作成時だけが有限回再試行される。
- [x] 非一過性エラーと既存 API レスポンス形状は変わらない。
- [x] 成功・上限到達・非一過性失敗の回帰テストがある。

## 対象外

worktree 作成以外の spawn 処理、cleanup / resource placement、リトライ対象の拡大。
