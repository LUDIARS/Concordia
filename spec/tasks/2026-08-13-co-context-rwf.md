---
task: co-context-rwf
project: Concordia
kind: 実装
created: 2026-08-13
memory_links:
  - spec/feature/phase-compaction.md
---
# /co-context コマンド + RWF context アクション

## 目的
コンテキスト残量をオンデマンドで報告する出口を 2 つ作る (phase-compaction §3)。
他タスクと無依存で先行可能。

## 完了条件
- `/co-context` がその場で `estimateContextTokens` を再実行し、占有 / window / 残量
  (トークンと %) / 前回コンパクション時刻 / 自動発火閾値までの余裕を報告する。
- 報告末尾の `[いまコンパクションする]` ボタンで `/co-compaction` 相当が起動する。
- RWF 語彙に `context` (🧠) が追加され、リアクションで同内容がスレッドへ投稿される。
  rwf-panel の候補に自動掲載される。
- コマンド・RWF・ボタンの単体テストが green。

## スコープ (編集可ディレクトリ)
- src/discord/
- src/cost/
- src/platform/
