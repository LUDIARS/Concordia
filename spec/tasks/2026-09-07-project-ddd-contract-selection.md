---
task: project-ddd-contract-selection
project: Concordia
kind: 実装
created: 2026-09-07
memory_links: []
---

# プロジェクト別DDD・契約適用設定

## 目的

Ccのプロジェクト画面でDDDとセッション契約を選び、選択したプロジェクトに要件を適用する。

## 完了条件

- チェック状態をCc DBに保存し、表示・API・実際の編集ゲートに接続する。
- 未選択プロジェクトに追加要件を強制せず、既存の安全規則は維持する。
- DDDの機械判定と設計品質のレビューを区別する。

## スコープ (編集可ディレクトリ)

src/db/、src/api/、src/harness/、web/src/、spec/。テスト・サービス操作は明示許可範囲のみ。
