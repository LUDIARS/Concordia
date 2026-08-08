---
task: taskflow-state-write-path
project: Concordia
kind: 実装
created: 2026-08-08
memory_links:
  - spec/feature/task-workflow.md
---
# Taskflow runtime state の遷移 write 経路を追加

## 目的

`taskflow_task_state` へ移行した status / assignee / pr_number 等の runtime state に
更新手段が無く、全タスクが移行時点の status に凍結される回帰を解消する。

## 背景 (delegation #797 レビュー所見 High)

- `readOrMigrate` は既存行があると frontmatter を無視するため、旧来の
  「md 編集による pending→delegated→done 遷移」が黙って無効化された。
- writer は移行 INSERT / `claimMemoriaCreation` / `recordMemoriaTaskId` のみで、
  status を変更する API・repo メソッドが存在しない。
- 影響: `residual-blackbox` が完了済みタスクを永遠に pending として再提案、
  `GET /v1/taskflow/tasks` の status フィルタと overview 集計が恒久的に陳腐化、
  done / cancelled へ到達不能。

## 完了条件

- status (および assignee / pr_number 等の runtime 値) を更新する経路を実装する
  (API 経由か、frontmatter 変更を state へ追従させる規則のどちらかを設計判断)。
- 遷移機構を spec/feature/task-workflow.md に明文化する。
- 遷移後の residual-blackbox / overview / API フィルタの挙動をテストで担保する。

## スコープ (編集可ディレクトリ)

- src/taskflow/
- src/api/
- spec/feature/
