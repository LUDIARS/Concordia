---
task: taskflow-frontmatter-db
project: Concordia
kind: 実装
created: 2026-08-08
memory_links:
  - spec/feature/task-workflow.md
---
# Taskflow runtime state の SQLite 移行

## 目的

タスク定義 Markdown を静的な仕様だけに保ち、実行時の taskflow 状態を SQLite へ移す。

## 完了条件

- 旧 frontmatter の runtime 値を安全に移行できる。
- reconciliation が Markdown を変更せず、Memoria task の重複作成を防ぐ。

## スコープ (編集可ディレクトリ)

- src/taskflow/
- src/db/
- src/api/
- spec/feature/
