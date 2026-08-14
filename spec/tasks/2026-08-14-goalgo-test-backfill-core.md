---
task: goalgo-test-backfill-core
project: Concordia
kind: テスト
created: 2026-08-14
memory_links:
  - spec/tasks/2026-08-13-ask-detach.md
  - spec/tasks/2026-08-13-vibes-mode.md
  - spec/tasks/2026-08-13-teams-core.md
  - spec/tasks/2026-08-13-co-context-rwf.md
---
# goalgo 実装 (#516) の未追加単体テストを補完する (backend)

## 目的

PR #516 で実装された機能のうち、元タスクの受け入れ条件が要求する単体テストが
未追加のまま残った箇所を補完する。挙動変更は行わない
(テスト容易化のための抽出リファクタのみ可)。

## 完了条件

- ask-detach: 質問 detach → run blocked → 回答 → 新 run で再開
  (worktree / branch / runtime 継承) の一連の単体テストが green
  (`src/taskflow/ask-detach.ts` に対するテストが現在 0 件)。
- `vibesFileLimit` 述語の単体テストが green。
- vibes `[OK]` → commit / local PR → claim release → vibes-completed → teardown の
  終了連鎖のテストが green (`src/bootstrap/core.ts` のインライン実装からの
  抽出リファクタ可)。
- team-provision: カテゴリ + 6 面の冪等プロビジョニング (保存済み ID 再利用・
  重複作成なし・部分欠落時の補完) の単体テストが green
  (`src/discord/team-provision.ts` に対するテストが現在 0 件)。
- /co-context: `buildContextReport` / 出力整形とコンパクションボタン handler の
  単体テストが green。
- 既存テストがすべて green のまま。

## 実装メモ (テスト容易化の抽出)

- vibes `[OK]` 終了連鎖は `src/bootstrap/core.ts` のインライン `eventBus.subscribe` から
  `src/control/vibes-completion.ts` (`startVibesCompletion`) へ抽出した (挙動同一、依存注入のみ追加)。
- `/co-context` コンパクションボタン handler は `src/discord/commands.ts` のインライン実装から
  `src/discord/commands/context.ts` (`handleContextCompactButton`) へ抽出した (挙動同一)。

## スコープ (編集可ディレクトリ)

- `src/taskflow/`
- `src/harness/`
- `src/control/`
- `src/discord/`
- `src/bootstrap/`
- 対応するテストファイル
