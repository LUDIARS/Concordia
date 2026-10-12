---
task: taskflow-failure-diagnostics
project: Concordia
kind: 実装
status: review
created: 2026-10-12T00:00:00.000Z
source_session: lictor-1de32fc6-b31a-4bd6-84b4-e56fd9fedb12
memoria_task_id: null
pr_number: null
actio_task_id: 50750667-147d-4e77-9fdd-a20e3a5a493e
memory_links: []
---
# taskflow_internal_error の原因を診断ログに残す (#27)

関連: Actio 50750667 (本タスク) / e705cc7d (元の不具合報告)

### 原因

`src/api/taskflow.ts` の `onError` は `log.warn({ reason, status })` しか記録していなかった。`src/taskflow/failure.ts` の `describeTaskflowFailure` は既知メッセージ以外をすべて `taskflow_internal_error` (500) に丸めるため、未分類の例外の種類・発生箇所がログに残らず、原因を特定できなかった。

### 変更

- `src/taskflow/failure-diagnostics.ts` (新設): 未分類例外のログ専用の診断を組み立てる。
  - `error_name`: 例外名 (識別子の形のものだけ)。非 Error 値は `non-error:<型>` にし、値の中身は出さない。
  - `error_message`: `redactSecrets` で秘密値を伏せ、URL のクエリと Windows の絶対パスを除き、1 行・200 字以内に縮める。
  - `error_site`: スタックのうち `node:` 内部と `node_modules` を除いた最初のフレームを、リポジトリ相対の `関数 @ path:line:col` にする (絶対パスは出さない)。
  - `cause_name` / `cause_code`: `cause` の例外名と、識別子の形のコード (`UND_ERR_CONNECT_TIMEOUT`、`ECONNRESET` など) だけを出す。
- `src/api/taskflow.ts`: reason が `taskflow_internal_error` のときだけ上記の診断を `log.warn` に加える。既知の失敗は従来どおり reason/status だけを記録する。**API 応答の形は変えていない。**
- `spec/feature/task-workflow-v3.md` (CC-TF-DIAG-01): ログにだけ出す診断項目を追記した。
- `augur.contracts.json` (`tf-diag-C-1`) と述語 `src/taskflow/failure-diagnostics.contract.ts`、`cc.acceptance.json`、`.augur/tests.jsonl`: 新しいソースとテストを対応付けた。membership は既存の taskflow ドメイン (`src/taskflow/*`, `src/api/taskflow*`) に含まれるため、ドメイン定義は変えていない。

### 再利用探索

- 秘密値を伏せる処理は、既存の `src/shared/redact-secrets.ts` (`redactSecrets`) を使った。
- 分類の仕組み (`describeTaskflowFailure`) には手を入れていない。応答に載る reason を増やすと API 応答が変わるため、診断はログ専用の別モジュールに分けた (SRP)。
- 当日の `GET /v1/taskflow/tasks` 500 の原因: `logs/concordia.log` は 09:15 の起動時で更新が止まっており、`taskflow-api` の行は 0 件だった。既存のログは reason/status しか残していないため、ログからは特定できなかった。この PR の反映後に再発すれば、`error_name` / `error_site` / `cause_code` で切り分けられる。

### 検証

- 実施: `tsc --noEmit -p tsconfig.json` (通過)、`tsc --noEmit -p tsconfig.test.json` (変更ファイルにエラーなし)、`vitest run src/taskflow/failure-diagnostics.test.ts src/api/taskflow-failure-log.test.ts src/api/taskflow-failure.test.ts src/taskflow/failure.test.ts` (26 件通過)、`augur tests lint` (registry valid)、`augur contracts lint` (新規の指摘なし。既存の 9 件は残っている)。
- 未実施: 全体テスト、サービスの起動・再起動 (作業条件で禁止)。vitest 中は Augur の契約観測が出ないため、`tf-diag-C-1` は集計上まだ未観測。

### 受け入れ条件

- C-1 describeTaskflowFailureDiagnostics(error): 未分類例外の診断は、例外名・秘密を伏せた 1 行 200 字以内のメッセージ・リポジトリ相対の発生箇所だけを返し、絶対パスや秘密値を含まない
