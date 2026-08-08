---
task: director-api-contract-tests
project: Concordia
kind: 実装
created: 2026-08-09
memory_links:
  - spec/tasks/2026-08-09-director-script-flow.md
  - spec/feature/task-workflow.md
---
# Director API の契約テストを追加する

## 目的

Director の case・step・判断・遷移を公開する HTTP API を、ルーター単位で回帰保護する。
実装済みの service テストだけに依存せず、要求・応答・失敗時ステータスの契約を固定する。

## 実装・確認事項

- `src/api/director.ts` に対する API テストを新設する。
- case 作成、case 詳細取得、判断記録、step 遷移の正常系を検証する。
- 不正入力と不正遷移が API 契約どおりの 4xx / 409 応答になることを検証する。
- 権限判断を要する操作が service 層の決定を迂回しないことを検証する。

## スコープ

- src/api/director.ts
- src/api/director.test.ts
- src/director/
- spec/tasks/
