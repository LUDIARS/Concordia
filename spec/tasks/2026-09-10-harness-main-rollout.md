---
task: harness-main-rollout
project: Concordia
kind: 雑用
created: 2026-09-10
memory_links:
  - spec/setup/harness-reliability.md
---
# 審査済みハーネスをCc本体へ反映する

## 目的
審査を通過したハーネスと設定画面を、Excubitor管理のConcordia本体で利用可能にする。

## 完了条件
- 審査対象commitと本体の反映commitを照合し、他者の変更を上書きしない。
- 必要なbackend・webビルドとschema migrationを確認する。
- Ccへのtesting claim後、必要な再起動をExcubitor HTTP経由で本体フォルダから実施する。
- health、追加API、プロジェクト別必須設定の表示と保存形式、配信Web成果物を確認する。
- claimを解放し、反映結果をCcの実行記録へ残す。

## スコープ (編集可ディレクトリ)
レビュー済みConcordia本体のビルド成果物と運用記録。CastraのGit操作、worktreeからのサービス起動は行わない。
