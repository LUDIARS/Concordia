---
task: resolve-pr1457-spec-linkage
project: Concordia
kind: 実装
created: 2026-09-07
memory_links: []
---

# PR 1457 の Anatomia spec_linkage 未通過を調査して解消する

## 目的

Revisor の LUDIARS/Concordia #1457 完了通知は Test OK・自動マージ
（`1640e33ef2ff`）と併せて「Anatomia gate(s) did not pass: spec_linkage」を報告した。
追加した UX・DDD 文書、既存の feature 契約、ドメイン所属、変更コードの参照関係を確認し、
仕様から実装を辿れる状態にする。通知だけでは未通過箇所や原因を断定しない。

## 完了条件

- 対象レビューの gate 詳細と spec_linkage の判定契約を読み、未解決の参照・所属・
  実装注釈等を具体的に特定する。レポート不足とコード・文書の不備を区別する。
- 確認した不備を、その仕様またはドメインの正本で修正する。リンクの存在だけでなく、
  参照先が対象の業務挙動・不変条件を説明していることを確認する。
- `spec/ux/` の安定 ID と draft の位置付けを維持し、UX の人間承認や DDD 全移行を捏造しない。
- ゲートの無効化、無関係な仕様リンクの追加、広範囲の所属変更で警告を隠さない。
- 静的に確認した参照関係と残る制約を成果物に明示する。テスト・サービス操作・
  gate の実行検証は、それぞれ許可された工程で行い、未実施を通過扱いにしない。

## スコープ (編集可ディレクトリ)

- `spec/domains/`、`spec/feature/`、`spec/ux/`、`spec/architecture/`、`spec/data/`：
  PR 1457 の変更に関係し、詳細レポートで不備が確認できた契約・参照のみ。
- `src/`、`web/src/`：対象関数の仕様注釈・所属に必要な最小修正のみ。挙動変更が必要なら
  孤立関数の調査タスクと重複させず、状態所有者と修正範囲を確認する。
- Anatomia や Praeforma のリポジトリは読み取り参照のみ。別プロジェクトの実装変更は含めない。

## 参照

- [DDD 方針](../architecture/ddd.md)
- [プロダクト UX](../ux/product.md)
- [孤立関数の調査タスク](2026-09-07-review-pr1457-orphan-functions.md)

進行状態は Concordia の `taskflow_task_state` が正本であり、このファイルを進行に合わせて更新しない。
