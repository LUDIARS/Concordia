---
task: verify-kaizen-fix-runtime-rollout
project: Concordia
kind: テスト
created: 2026-08-31
memory_links:
  - https://github.com/LUDIARS/Concordia/pull/1139
  - spec/plan/problem_logs/2026-08-31-taskflow-workspace-root-task-collision.md
  - spec/plan/problem_logs/2026-08-31-ok-hand-reaction-triggered-handoff.md
---
# Kaizen 修正をランタイムへ反映して確認する

## 目的

マージ済み commit `0d49a10673dc` の task routing 修正と `👌` 予約ガードを、実行中の Concordia backend に反映して運用経路で確認する。現行 backend はマージ前の 2026-08-29 22:16 JST に起動されている。

## 完了条件

- Concordia 本体フォルダのマージ済み `main` を使用し、必要な build と Excubitor 経由の再起動を行う。
- 再起動前に Concordia testing claim を取得し、終了時に release する。
- workspace root の絶対パス指定が同名の子リポタスクを選択しないことを確認する。
- 組み込み、設定 override、custom workflow、外部 workflow、管理 API の各経路で `👌` を action に割り当てられないことを確認する。
- `👋` の明示 handoff 動作が維持されていることを、副作用を残さない方法で確認する。

## スコープ (編集可ディレクトリ)

- .
