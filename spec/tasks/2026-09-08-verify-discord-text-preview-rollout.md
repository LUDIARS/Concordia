---
task: verify-discord-text-preview-rollout
project: Cc
kind: verification
created: 2026-09-08
memory_links:
  - spec/feature/discord-ui.md
  - spec/tasks/2026-09-08-discord-expandable-text-attachments.md
---

# テキスト添付の展開を稼働環境へ反映・確認する

## 目的
PR #1475（マージコミット c90ca8948607）の添付表示処理を稼働環境へ反映し、Discordで成果資料を読めることを確認する。UX-CC-W3、CC-INV-06。既存の資料共有inject反映タスクとは、実際の添付変換処理と表示の確認を対象とする点が異なる。

## 受け入れ条件
- 対象版・稼働プロセス・配信コードを照合し、未反映の場合だけ正規の配備を行う。
- 許可された送信先でMarkdown・JSON・日本語UTF-8添付の展開を確認する。元の内容とローカルファイルを保持する。
- 長文の全文取得、バイナリの非変換、既存送信先と配達記録を確認する。Discord側のプレビュー上限を全文欠損と混同しない。

## 作業範囲と実行条件
対象はConcordia。現行checkoutとCc登録を照合し、他セッションの差分を保全する。
テスト・送信を伴う動作確認・起動・再起動はユーザーの明示許可範囲で行う。
サービス操作は事前にtesting claimを取得し、Excubitor経由・プロジェクト本体フォルダ限定で実施、終了後releaseする。
main更新・マージを独自に実行しない。進行状態はtaskflow_task_state、結果の証拠は別の運用記録へ残し、このmdへ書き戻さない。
