---
task: taskflow-state-rename-dedup
project: Concordia
kind: 実装
created: 2026-08-08
memory_links:
  - spec/feature/task-workflow.md
---
# Task md rename 時の state 引き継ぎと Memoria 重複防止

## 目的

task md の rename / 移動 (または repo パス変更) で `taskflow_task_state` の行が
孤児化し、reconciler が同じタスクを Memoria へ重複登録する問題を防ぐ。

## 背景 (delegation #797 レビュー所見 Medium)

- state の key は `(repo_path, task_path)` のため、ファイル rename で新規行として
  扱われ、status 喪失 + `memoria_registration_state=idle` から再 claim → 重複作成が起きる。
- 旧実装は `memoria_task_id` が frontmatter に載ってファイルと共に移動したため
  この問題は無かった (移行による後退)。
- 旧パスの孤児行を掃除する機構も無い。

## 完了条件

- rename / 移動後も既存 state (特に memoria_task_id / status) を引き継ぐ、
  もしくは重複登録を防ぐ照合手段を実装する (task slug 照合等、方式は設計判断)。
- スキャンで消えた task_path の孤児行の扱い (掃除 or 保持) を決めて実装する。
- rename シナリオの回帰テストを追加する。

## スコープ (編集可ディレクトリ)

- src/taskflow/
- src/db/
- spec/feature/
