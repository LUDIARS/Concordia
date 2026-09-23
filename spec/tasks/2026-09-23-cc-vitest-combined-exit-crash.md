---
task: cc-vitest-combined-exit-crash
project: Concordia
kind: テスト
created: 2026-09-23
memory_links:
  - spec/feature/codex-hook-console-free.md
  - spec/plan/problem_logs/2026-09-23-clipboard-mime-and-hook-focus.md
---
# Vitest一括実行後の終了クラッシュを切り分ける

## 目的
72件のassertion成功後に0xC0000005で終了した一括実行について、分割実行の成功と区別し原因を特定する。

## 完了条件
- 同じテスト集合と終了コードを記録し、終了クラッシュを再現できる範囲を絞る。
- DBを使うdelegation blockと他suiteの組合せ・終了処理を調べる。
- 既存のthreads方針を守り、非表示実行・claim/releaseを維持する。
- 根本原因と対処、または未再現の条件を障害記録へ残す。

## スコープ (編集可ディレクトリ)
Concordia/vitest.config.ts、tests/helpers、対象テストとspec/plan/problem_logs。
