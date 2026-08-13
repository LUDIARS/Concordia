---
task: teardown-bugfixes
project: Concordia
kind: 実装
created: 2026-08-13
memory_links:
  - spec/feature/deterministic-teardown.md
---
# パートタイマー残留の即時バグ修正 2 点

## 目的
spec 実装に先行して、タスクワーカー残留の直接原因 2 つを止める
(deterministic-teardown §1)。

## 完了条件
- `hasRecordedInquiry` (src/taskflow/session-end.ts) の判定がセッション生涯 1 回ではなく
  run / タスク単位になり、goal-and-go 継続後の 2 タスク目完了でもお伺いが送られる。
- goal-and-go 未 opt-in のパートタイマーにも完了お伺いが送られる
  (`shouldEndAutonomousTaskflow` の goalAndGoEnabled 必須を外し、opt-in は次タスク自走の
  分岐のみに使う)。
- 両修正の単体テストが green。

## スコープ (編集可ディレクトリ)
- src/taskflow/
