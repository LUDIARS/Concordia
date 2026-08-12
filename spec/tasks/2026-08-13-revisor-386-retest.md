---
task: revisor-386-retest
project: Concordia
kind: テスト
created: 2026-08-13
memory_links:
  - spec/tasks/2026-08-12-clean-worktree-bootstrap.md
  - spec/plan/problem_logs/2026-08-12-revisor-381-clean-worktree-bootstrap.md
---

# Revisor #386 を拡張済みの登録テスト枠で再審査する

## 目的

Revisor #386 は製品テストの失敗ではなく、旧登録設定の 10 分上限で `test` と
`lint` が中断された。#496 で clean worktree bootstrap と 30 分の登録テスト枠が
main に入った後、この前提で #386 を State 0 から再申請する。

## 完了条件

- #386 の再申請時点で、Revisor の登録テスト設定が bootstrap を先行し、`test` の上限が 30 分である。
- Revisor が #386 の登録テストを開始し、最終結果を通知する。
- 失敗した場合は、上限超過ではない具体的な失敗だけを次の作業へ引き継ぐ。

## スコープ (編集可ディレクトリ)

- `spec/tasks/` — 本タスク定義の新規保存のみ。
- Revisor の local PR #386 に対する再申請操作。実装ファイルは、この再審査で新たな失敗根拠が得られた場合にだけ別タスクで扱う。
