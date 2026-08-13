---
task: plan-approve-flow
project: Concordia
kind: 実装
created: 2026-08-13
memory_links:
  - spec/feature/plan-gate.md
  - spec/feature/deterministic-teardown.md
---
# プラン承認 → task md 確定 → ワンショット委託 + 封鎖述語

## 目的
承認済みプランを実行に接続し、未承認の間の実装をハーネスで封鎖する
(plan-gate §2.3, §4, §5)。

## 完了条件
- 承認でプランの「タスク分解」節の task md 保存 inject が飛び、reconciler 経由で
  ワンショット委託が起案される。
- 述語 `plan-unapproved` が mode=plan セッション (と同 case の委託子) のコード編集を
  承認まで deny する (.md / spec / docs 除外)。
- 破棄で case が cancelled になり、封鎖は維持される。
- vibes → plan 昇格 / plan → vibes 降格 (人間承認のみ) が契約更新として動く。
- 封鎖・接続・昇格降格の単体テストが green。

## スコープ (編集可ディレクトリ)
- src/director/
- src/harness/
- src/taskflow/
- src/delegation/
