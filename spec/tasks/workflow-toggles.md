---
task: workflow-toggles
project: Concordia
kind: 実装
status: done
created: 2026-08-08T00:00:00.000Z
source_session: lictor-6535777e-6059-4137-b4e7-6684f2b7e614
memoria_task_id: null
pr_number: null
actio_task_id: null
memory_links: []
---
# W1 + W6 — ワークフローの個別有効化 / 設定値の都度解決

設計正本: `spec/feature/workflow-toggles-and-permission-noise.md` の W1 節・W6 節
(別ブランチで追加される設計書。 本 PR ではコード側だけを実装する)。

## 目的

Concordia を「セッションコントロールのみ」でも使えるようにする。 ワークフローを使わない
拠点・個人利用でも、 セッション登録 / inject / transcript 中継 / 許可応答 / 停止だけを
動かせる構成を作る。

## 完了条件

- [x] `workflow.task` / `test` / `reaction` / `review` / `daily` / `cost` を
      DB (`admin.workflow.<key>.enabled`) + env (`CONCORDIA_WORKFLOW_<KEY>_ENABLED`)
      フォールバックで持つ。 既定は全て有効。
- [x] 無効時は該当ワークフローのイベント購読・スケジューラ登録・Discord コマンド登録を
      行わない (動かしたまま投稿だけ止める、 にしない)。
- [x] 全部無効 = セッションコントロールのみ構成。 この状態でセッション登録 / inject /
      transcript 中継 / 許可応答 / 停止が動くことを回帰テストで固定する。
- [x] 無効なワークフローに属する API は 404 ではなく 409 + 理由。
- [x] W6: 設定値は関数で都度解決する形へ統一
      (`shouldPostPermissionRequestToDiscord` の起動時 env スナップショットを解消)。
- [x] 購読やスケジューラを伴うフラグは値の変化を検知して登録側を張り替える。

## スコープ (編集可ディレクトリ)

- `src/workflow/` (新設: keys / toggles / binding-registry / api-gate)
- `src/admin/` (AdminState からの公開)
- `src/api/` (409 ゲート + `/v1/admin/workflows`)
- `src/bootstrap/core.ts` (binding 化)
- `src/discord/` (コマンド登録 / リアクション購読 / W6 resolver)

## やらないこと

- 設定 UI の集約 (W5)
- RWF のアクション追加 (W2)
- 許可要求の絞り込みロジック (W3、 Lictor 側)

## 実装状況

新設モジュール:

- `src/workflow/keys.ts` — キー定義と DB / env の名前解決。
- `src/workflow/toggles.ts` — `WorkflowToggles`。 DB → env → 既定 (true) の順で
  **都度解決**。 解釈できない値は警告して次の解決元へ進む (無言フォールバックしない)。
- `src/workflow/binding-registry.ts` — `WorkflowBindingRegistry`。 無効な binding は
  start せず、 有効→無効で stop、 無効→有効で張り直す。 5 秒間隔の watcher 付き。
- `src/workflow/api-gate.ts` — 409 + 理由 (`setting_key` / `env_name` 付き) を返す
  Hono middleware。

配線:

- `bootstrap/core.ts` の購読 / スケジューラを binding へ移設
  (testing-claim-release / testing-branch-watch / revisor-local-pr-auto-submit /
  pr-ingest-watcher / pr-reconciler / pr-full-sync / task-reconciler /
  taskflow-runtime / morning-scheduler / cron-scheduler / daily-report-scheduler /
  cost-sampler)。
- Discord: `mmtask`→task / `confirm`→test / `prs`→review を無効時は guild へ登録せず、
  dispatch 側でも二段で断る。 リアクション購読は `client.on/off` で張り替える。
- W6: `src/discord/permission-request-flag.ts` の `toPermissionRequestsResolver` で
  `conn_permission_requests_enabled` を都度解決 (`src/pr/revisor-token.ts` と同じ形)。
