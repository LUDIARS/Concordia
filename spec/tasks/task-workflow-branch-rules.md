---
task: task-workflow-branch-rules
project: Concordia
kind: 実装
status: pending
created: 2026-07-17T00:00:00.000Z
source_session: lictor-340dbfff-25a8-4bd0-9a66-8ba0a0ceb69e
memoria_task_id: 537
actio_task_id: null
memory_links: []
---
# タスクワークフローの作業ブランチ規約を明文化しハーネスへ記載する

## 目的

neco 指示 (2026-07-17): 作業ブランチとルールの徹底化。対話セッションを含む
すべての実装作業を「セッション起動 → 作業内容解析 → 作業ブランチ確定 →
ワークツリー生成 → 作業 → 作業完了 → タスクワークフローに積む → コミット・PR」
の一本の流路に載せる。レビューとテストは作業完了後に非同期でよい。
テストワークフロー (confirm) は現状のまま。**このフローではオートマージ禁止**。

## 完了条件

- spec/feature/task-workflow.md に作業ブランチ規約の節が追加され、
  フロー・非同期レビュー/テスト・オートマージ禁止が明記されている。
- ハーネス builtin ルール (src/subsidiary/harness-seed.ts) に
  「作業ブランチ + worktree 必須」「オートマージ禁止」が追加され、
  boot 時に冪等 seed される。
- 既存の harness gate テストが緑のまま。

## スコープ (編集可ディレクトリ)

- spec/feature/ (task-workflow.md)
- spec/tasks/ (この md)
- src/subsidiary/ (harness-seed.ts)
