---
task: review-pr1475-orphan-function
project: Cc
kind: review
created: 2026-09-08
memory_links:
  - spec/architecture/ddd.md
---

# PR #1475の孤立関数所見を調査する

## 目的
RevisorのPR #1475完了通知に「1 changed function(s) are orphaned」という非ブロック所見がある。通知に関数名はないため、不使用コードや不具合とは断定せず、対象と到達経路を特定する。

## 受け入れ条件
- Revisorの詳細証跡から対象関数と解析条件を特定し、マージコミットc90ca8948607の差分と照合する。
- 呼び出し・登録・テスト経路とドメイン所属を確認し、未接続、解析上の未検出、意図した公開入口を区別する。
- 修正が必要なら対象repoの専用worktreeで最小変更と仕様参照を整え、Revisor local PRへ提出する。不要なら根拠を別の調査記録へ保存する。

## 作業範囲と実行条件
対象はConcordia。現行checkoutとCc登録を照合し、他セッションの差分を保全する。
テスト・送信を伴う動作確認・起動・再起動はユーザーの明示許可範囲で行う。
サービス操作は事前にtesting claimを取得し、Excubitor経由・プロジェクト本体フォルダ限定で実施、終了後releaseする。
main更新・マージを独自に実行しない。進行状態はtaskflow_task_state、結果の証拠は別の運用記録へ残し、このmdへ書き戻さない。
