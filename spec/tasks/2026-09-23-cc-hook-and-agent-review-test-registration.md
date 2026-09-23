---
task: cc-hook-and-agent-review-test-registration
project: Concordia
kind: 実装
created: 2026-09-23
memory_links:
  - spec/domains/hook-transport.domain.json
  - spec/domains/internal-agent-model-policy.domain.json
  - cc.acceptance.json
---
# hookと内部AgentドメインのRevisorテスト登録を補う

## 目的
Revisorのドメイン別計画でhook-transportとinternal-agent-model-policyが0件扱いになる差を解消する。

## 完了条件
- cc.acceptance.jsonのsource/tests対応と、Revisorが使用する登録元・runnerを照合する。
- 既存のNode test/Vitest回帰を適切なドメインへ対応付け、テストの二重作成を避ける。
- レビュー計画に対象テストが現れ、実行件数を確認する。
- 孤立関数と旧複雑度集計の所見は根拠を確認し、必要な対応だけを分離する。

## スコープ (編集可ディレクトリ)
Concordiaのテスト登録設定・spec/domains・cc.acceptance.json。Revisor本体の変更が必要なら別途対象を明確化する。
