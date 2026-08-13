---
task: phase-compaction
project: Concordia
kind: 実装
created: 2026-08-13
memory_links:
  - spec/feature/phase-compaction.md
  - spec/feature/session-compaction.md
---
# フェーズ境界コンパクション (taskflow 接続 + 機械組み立て再配置 + 索引)

## 目的
コンパクションの発火をフェーズ確定イベントに接続し、再投入文脈を正本から機械組み立てする
(phase-compaction §1, §2)。

## 完了条件
- `taskflow:plan-approved` / `taskflow:next-task` / `taskflow:residual-sweep` で境界評価が
  走り、`CONCORDIA_PHASE_COMPACT_PCT` (既定 0.35) 以上で compact、未満は再配置 inject のみ
  になる (クールダウン・作業中ガードは現行維持)。
- 再投入文脈が三層 (機械組み立て: 契約+プラン+タスク+PR / handoff 作文 / message link
  索引) で組まれ、索引に契約カード・プラン最新版・設問回答・直近 handoff が載る。
- カード投稿時の message id 記録が揃い、索引が探索なしで組める。
- 境界評価・三層組み立て・索引の単体テストが green。

## スコープ (編集可ディレクトリ)
- src/control/
- src/taskflow/
- src/cost/
- src/discord/
- src/config/settings/
