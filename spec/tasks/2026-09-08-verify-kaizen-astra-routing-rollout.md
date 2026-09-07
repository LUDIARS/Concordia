---
task: verify-kaizen-astra-routing-rollout
project: Cc
kind: verification
created: 2026-09-08
memory_links:
  - spec/feature/delegation.md
  - spec/tasks/2026-09-08-kaizen-parttimer-astra.md
---

# カイゼンのAstra起動と難易度別対応を反映・確認する

## 目的
PR #1475（マージコミット c90ca8948607）のseedとプロンプト契約を稼働中Ccへ反映し、指定モデル・作業配分・退勤を確認する。UX-CC-AD-W1、CC-INV-02/04/08。過去のtask routing修正の反映タスクとは別の対象版・契約を扱う。

## 受け入れ条件
- kaizen-dailyのprovider/modelがCodex/gpt-6-astraとなり、既存テンプレートの同一性と毎朝のスケジュールが保たれる。
- 承認された確認範囲で、新規起動へ難易度判断、高難度のAstra自身による実装、低難度の適切なモデルへの委託が渡ることを確認する。
- 判断に困る候補がタスク化され、pendingと人間の担当がDBに保存されることを確認する。自動再委託・確認ループを作らず、partial報告と退勤へ進む。
- 進行中runの担当を変更せず、受付・起動・PR提出・マージ完了を区別する。

## 作業範囲と実行条件
対象はConcordia。現行checkoutとCc登録を照合し、他セッションの差分を保全する。
テスト・送信を伴う動作確認・起動・再起動はユーザーの明示許可範囲で行う。
サービス操作は事前にtesting claimを取得し、Excubitor経由・プロジェクト本体フォルダ限定で実施、終了後releaseする。
main更新・マージを独自に実行しない。進行状態はtaskflow_task_state、結果の証拠は別の運用記録へ残し、このmdへ書き戻さない。
