---
task: director-workflow
project: Concordia
kind: 実装
created: 2026-08-20
memory_links:
  - spec/feature/director-workflow.md
  - spec/feature/director-patrol.md
  - spec/feature/team-standup-and-review.md
---
# ディレクターワークフロー (タスク取得 delegation + タスク整理)

## 目的

2026-08-20 neco 指示: 「ディレクターワークフローという概念を用意する。現場を回す人の
ワークロードです。Memoria のタスクから関連する未完了タスクを引っ張る Delegation と、
それを使ってタスク整理を行うディレクターワークフローを用意」を
spec/feature/director-workflow.md として設計し、フルセットで実装する。

## 完了条件

- delegation `director-task-pull` (関連未完了タスクの読み取り専用取得) が seed される。
- delegation `director-task-organize` が毎日 10:00 JST にチームごとへ fanout し、
  4 分類 (実行可能 / 実態完了 / 判断待ち / 浮いている) で整理する。
- `POST /v1/director/cases/:caseId/steps` で既存 case へ step を末尾採番で追加できる。
- 追加された pending delegate step を director-patrol が実行候補として扱える。
- 整理結果が `task-kanban` カードとしてタスクボード面へ投稿される。
- Vitest でカバーする。

## スコープ (編集可ディレクトリ)

- `src/director/` `src/api/` `src/delegation/seed.ts` `src/scheduler/cron-jobs.ts`
- `src/discord/team-post-card.ts` `src/events.ts`
- `spec/feature/` `spec/tasks/` `spec/domains/` `tests/`
