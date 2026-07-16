---
task: 2026-07-16-slack-session-channels
project: Concordia
kind: 実装
status: delegated
created: 2026-07-16
assignee: GPT (gpt-5.6-sol)
delegation_run_id: af068e9c-36bd-49d9-9d6e-b2a1170f676d
pr_number: 343
memoria_task_id: 512
actio_task_id: null
memory_links:
  - spec/plan/tasks/slack-session-channels.md
---
# Slack session-per-channel 対応

## 目的

Slack ではセッションごとのスレッドを廃止し、BOT のみが参加するセッション専用チャンネルへ会話を集約する。通知の迷惑性を抑えつつ、旧 Concordia のチャンネル方式に近い運用と Sessions Canvas による一覧性を実現する。

## 完了条件

- セッション開始時に BOT 専用の Slack チャンネルを作成し、そのセッションの投稿を同チャンネルへ配送する。
- セッション終了時のアーカイブ処理と、Sessions Canvas の一覧更新を実装する。
- 必要な Slack scope・設定・運用手順を仕様へ反映する。
- lint、unit test、build、dependency-cruiser が成功する。
- `feat/slack-session-channels` を push し、squash merge 可能な PR を 1 件作成する。

## スコープ

- `src/slack/`
- Slack 経路に必要な read model、DB schema、bootstrap 配線
- 関連テストと Slack setup/spec

設計正本: [slack-session-channels.md](../plan/tasks/slack-session-channels.md)
