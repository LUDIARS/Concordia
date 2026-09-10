---
task: harness-registered-verification
project: Concordia
kind: 実装
created: 2026-09-10
memory_links:
  - spec/feature/harness-reliability.md
  - spec/feature/project-harness-policy.md
---
# ハーネス改善の登録検証と仕様リンクを整える

## 目的
プロジェクト別受入設定とハーネス観測の変更を、登録テスト・依存検査・仕様リンクで検証できるようにする。

## 完了条件
- 追加したDB migrationの凍結エントリと適用後スキーマ指紋が一致し、過去migrationの値を変更しない。
- 契約なし委託のテストがホストリポジトリのAugur契約を読み込まない。
- 型の循環依存と観測イベント名の設定キー誤検出を解消する。
- 登録テスト・lint・buildが成功し、変更コードのAnatomia所属と仕様リンクを確認する。
- 検証済み変更を既存のRevisor提出へ反映し、審査結果を確認する。

## スコープ (編集可ディレクトリ)
`src/`、`tests/`、`tools/`、`web/src/`、`.anatomia/layers.json`、関連する`spec/`。
テストや受入ゲートを無効化して通過させない。
