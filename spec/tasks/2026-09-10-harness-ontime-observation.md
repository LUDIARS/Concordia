---
task: harness-ontime-observation
project: Concordia
kind: テスト
created: 2026-09-10
memory_links:
  - spec/feature/harness-reliability.md
  - spec/setup/harness-reliability.md
---
# 本体でハーネス適用とオンタイム契約を観測する

## 目的
導入したハーネスが通常の操作経路で動き、LLMを使わず契約ログを集計できることを確かめる。

## 完了条件
- 対象期間・実装markerを指定して本体の契約ログをスクリプトで集計する。
- 未観測、条件充足、違反、述語例外を区別し、隔離テストを本番効果と数えない。
- セッション関連作業欄とAPIの実観測記録を確認する。
- 圧縮復旧・MCP認証切れ・通知配送は実イベントがある範囲だけ確認済みとし、未発生を成功にしない。
- 共有資料のDiscord投稿先と配送記録を照合する。
- 観測結果はCcの実行記録に残し、このタスク本文へ進行状態を書き戻さない。

## スコープ (編集可ディレクトリ)
本体の隔離検証用一時出力、Ccの観測APIと既存JSONL。契約集計のためにLLMや別の定期回帰サービスを起動しない。
