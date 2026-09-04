---
task: reaction-injection-provenance
project: Concordia
kind: 実装
created: 2026-08-31
memory_links:
  - spec/plan/problem_logs/2026-08-31-ok-hand-reaction-triggered-handoff.md
  - spec/feature/reaction-workflow.md
---
# Reaction Workflow 注入の provenance を保持する

## 目的

リアクションから生成された session inject が通常の直接入力と区別できるように、workflow の出所情報を保存・伝播する。生成指示が `User` / `platform = null` として直接入力同様に見える状態を解消する。

## 完了条件

- reaction workflow の action、platform、発火元メッセージ、発火ユーザーを照合できる provenance が注入経路から session message の正本まで失われない。platform ID の生値は保存せず、照合用 reference に最小化する。
- モデルへ渡す入力には action/platform を含む機械生成ヘッダーを付け、workflow が生成した指示とユーザーの直接入力を判別できる。
- Discord と Slack の共通注入経路で provenance の保持を検証する回帰テストがある。
- `👌` の恒久的な非アクション保証と `👋` の handoff 動作を維持する。

## スコープ (編集可ディレクトリ)

- src/platform/
- src/discord/
- src/slack/
- src/api/
- src/db/
- src/messages/
- src/shared/
- tests/
- spec/feature/
- spec/domains/
- spec/tasks/
