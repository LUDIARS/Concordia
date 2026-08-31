---
task: resolve-pr1139-anatomia-orphans
project: Concordia
kind: 実装
created: 2026-08-31
memory_links:
  - https://github.com/LUDIARS/Concordia/pull/1139
  - https://github.com/LUDIARS/Concordia/pull/1137
---
# PR #1139 の Anatomia orphan を解消する

## 目的

PR #1139 の Revisor レビューで非ブロックとして残った orphaned changed function 3 件を特定し、呼び出し関係または不要コードを整理する。未分類 anchor は既存 task `anatomia-dual-layer-unclassified-anchors` で扱い、重複させない。

## 完了条件

- merge commit `0d49a10673dc` とその親 `bbe4eceaa011` の差分を対象に、3 件の orphaned function の一覧が再現できる。
- 各 function が到達可能な呼び出し関係へ接続されるか、不要なら削除される。
- 同じ差分条件で Anatomia を再確認し、changed orphan が残っていない。
- PR #1139 で導入した task routing と予約 reaction の振る舞いを変更しない。

## スコープ (編集可ディレクトリ)

- src/
- tests/
