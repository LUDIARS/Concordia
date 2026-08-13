---
task: status-partial-requeue
project: Concordia
kind: 実装
created: 2026-08-13
memory_links:
  - spec/feature/deterministic-teardown.md
  - spec/feature/task-workflow.md
---
# status partial + remaining 再キュー

## 目的
「タスクに続きがある」を同一セッション延命ではなく新規ワンショット run の再キューにする
(deterministic-teardown §3)。

## 完了条件
- `POST /v1/delegation/runs/:id/status` が `partial` + `remaining[]` +
  `acceptance_report[]` を受理する (completed 契約は後方互換)。
- partial 受信で remaining が task md / taskflow state に落ち、契約・worktree・branch を
  引き継いだ新規 run が起案され、報告元セッションは teardown ladder に入る。
- 契約フィールド `continuation: requeue | in-session` (既定 requeue) が分岐に効く。
- acceptance_report の `met: false` が residual 判定へ未達条件として渡り、未達のまま
  完了で閉じない。
- API・再キュー・残条件伝搬の単体テストが green。

## スコープ (編集可ディレクトリ)
- src/api/
- src/delegation/
- src/taskflow/
- src/db/
