---
task: anatomia-dual-layer-unclassified-anchors
project: Concordia
kind: 実装
created: 2026-08-31
memory_links:
  - https://github.com/LUDIARS/Concordia/pull/1137
  - spec/feature/reaction-workflow.md
---
# Anatomia dual-layer の未分類 anchor を解消する

## 目的

Revisor による PR #1137 のレビューで報告された
`Anatomia dual-layer (program): 129 changed anchor(s) unclassified` を調査し、
変更された program anchor が未分類になる原因を明らかにして分類を完了する。

## 完了条件

- PR #1137 に由来する 129 件の未分類 anchor を再現可能な一覧として特定できる。
- 各 anchor を既存の Anatomia dual-layer 分類へ割り当てるか、既存分類で表現できない場合は分類定義を追加できる。
- 誤検知が含まれる場合は、正当な anchor を除外せずに検出規則または入力データを是正できる。
- 再評価で未分類 anchor が 0 件になるか、残る項目ごとに未分類とする明示的な根拠を残せる。
- PR #1137 で導入したリアクションワークフローの振る舞いを変更しない。

## スコープ (編集可ディレクトリ)

- `spec/`
- `src/anatomia/`
- `tools/`
- 上記の分類・検証に直接関係するテストファイル
