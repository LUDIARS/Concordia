---
task: revisor-local-pr-client-timeout
project: Concordia
kind: 実装
created: 2026-08-13
memory_links:
  - spec/tasks/2026-08-13-revisor-381-retest.md
  - spec/tasks/2026-08-13-revisor-386-retest.md
---

# Revisor local PR client の一覧・再申請タイムアウトを見直す

## 目的

Revisor の local PR 一覧取得が 15 秒を超えると、Cc が提出・再申請の前段で
AbortController により中断する。レビューキューが多い環境でも Cc 経由の
local PR 提出と retry を完了できるようにする。

## 完了条件

- Revisor local PR client の一覧取得・提出・retry は、通常のローカル Revisor 応答時間を超えない有限上限を使う。
- Revisor が 15 秒を超えて応答する場合も、Cc は `This operation was aborted` ではなく提出結果を返す。
- タイムアウト時は現在の fail-fast なエラー伝播を維持し、無言の成功扱いにしない。

## スコープ (編集可ディレクトリ)

- `src/pr/` — Revisor local PR client とその単体テスト。
- `spec/plan/problem_logs/` — 本障害の記録。
