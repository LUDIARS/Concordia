---
task: startup-policy-alignment
project: Concordia
kind: 実装
created: 2026-09-11
memory_links:
  - spec/feature/shared-startup-context.md
---
# 初期InjectとSessionStartの設定判定を揃える

## 目的
workflowと構成による初期ルールの選択をCcで共通化し、フックが古い案内や別repoの登録を上書きしないようにする。

## 完了条件
- 初期InjectとSessionStart・入力時の照合が同じworkflow・構成判定を使う。
- 同じ設定版は再注入せず、変更時は訂正し、初期案内の記録がなければ補完する。
- repo・branch・providerの不一致、照会失敗、到着未確認を区別する。
- DDD・テスト・オンタイム必須設定を案内し、実行許可は追加しない。
- 同時照合、遅延初期通知、登録変更との競合を検証する。
- Revisor審査後の本体反映と実フック観測を確認する。

## スコープ (編集可ディレクトリ)
`src/control/`、`src/api/sessions/`、`tools/concordia-hook.mjs`、対応テストと仕様。
