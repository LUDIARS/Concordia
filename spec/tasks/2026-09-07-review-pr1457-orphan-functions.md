---
task: review-pr1457-orphan-functions
project: Concordia
kind: レビュー
created: 2026-09-07
memory_links: []
---

# PR 1457 の孤立関数6件を調査し、必要な接続を整理する

## 目的

Revisor の LUDIARS/Concordia #1457 完了通知は Test OK・自動マージ
（`1640e33ef2ff`）と併せて「6 changed function(s) are orphaned」を報告した。
通知には関数名や判定理由がないため、未使用コードと決め付けず、各関数の呼び出し元・
登録経路・ドメイン所属を確認する。業務上必要な処理が未接続なら修正し、静的解析の
検出限界なら、その根拠をレビュー成果として残す。

## 完了条件

- 対象レビューの詳細から6件の関数名・ファイル・判定根拠を特定する。詳細を取得できない場合は
  推測で削除せず、不足している証拠と調査上の制約を明示する。
- 各関数について実際の呼び出し・イベント登録・公開 API 等の到達経路を確認し、
  接続漏れ、不要コード、解析上の孤立のいずれかを根拠付きで判定する。
- 修正が必要な場合は、既存の状態所有者と `CC-INV-03/04/06/07` を守る最小変更とし、
  警告を消すためだけの無意味な呼び出しを追加しない。
- 検証の実施範囲と未実施範囲を区別する。テスト・起動・再起動は別途明示許可がある場合だけ行う。

## スコープ (編集可ディレクトリ)

- `src/github/`、`src/delegation/`、`src/shared/`、`src/discord/`：該当関数が存在すると確認できた箇所のみ。
- `src/` 直下の `chat-worker.ts`、`cost-worker.ts`、`workflow-worker.ts`：該当する登録・寿命管理のみ。
- `spec/domains/`、`spec/feature/`、`spec/plan/problem_logs/`：調査に対応する所属・契約・証拠。
- 対象が上記以外なら先にスコープを確認し、別プロジェクトや解析ゲートの無効化へ広げない。

## 参照

- [DDD 方針](../architecture/ddd.md)
- [プロダクト UX](../ux/product.md)
- [5件の修正の問題記録](../plan/problem_logs/2026-09-07-workflow-lifecycle-notification-reliability.md)

調査結果や進行状態はこのファイルへ書き戻さず、成果物と Concordia の DB で管理する。
