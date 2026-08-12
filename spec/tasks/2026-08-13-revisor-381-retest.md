---
task: revisor-381-retest
project: Concordia
kind: テスト
created: 2026-08-13
memory_links:
  - spec/tasks/2026-08-12-clean-worktree-bootstrap.md
  - spec/plan/problem_logs/2026-08-12-revisor-381-clean-worktree-bootstrap.md
---

# Revisor #381 を bootstrap 修正後の前提で再審査する

## 目的

Revisor #381 が clean worktree の bootstrap 不備により審査できなかったため、
その前提を解消した #496 の自動マージ後に #381 を State 0 から再申請し、
登録テストが実際の変更内容を評価できる状態に戻す。

## 完了条件

- #381 の再申請時点で、審査対象は #496 を含む main を基点としている。
- Revisor が #381 の登録テストを開始し、最終結果を通知する。
- 失敗した場合は、失敗したテスト名と再現可能な原因だけを次の作業へ引き継ぐ。

## スコープ (編集可ディレクトリ)

- `spec/tasks/` — 本タスク定義の新規保存のみ。
- Revisor の local PR #381 に対する再申請操作。実装ファイルは、この再審査で新たな失敗根拠が得られた場合にだけ別タスクで扱う。
