---
task: director-schema-index-cleanup
project: Concordia
kind: 実装
created: 2026-08-09
memory_links:
  - spec/tasks/2026-08-09-director-script-flow.md
---
# Director step の重複インデックスを整理する

## 目的

`director_steps` の一意制約と同じキーを持つ冗長な通常インデックスを整理し、スキーマの意図と
実際の索引構成を一致させる。

## 実装・確認事項

- `idx_director_steps_case_sequence` が一意制約由来の索引と重複することを確認する。
- 既存 DB を含めて安全に不要なインデックスを除去する migration を追加する。
- step の case / sequence 一意性と主要な一覧クエリの実行計画が維持されることを検証する。

## スコープ

- src/db/schema.ts
- src/db/
- spec/tasks/
