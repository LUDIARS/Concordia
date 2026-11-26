# Task workflow failure visibility

> 所属ドメイン: [`http-interface`](../domains/http-interface.domain.json) · [`session-message-webui`](../domains/session-message-webui.domain.json) · [`taskflow`](../domains/taskflow.domain.json)

## CC-TF-ERROR-01

2026-10-17 neco requested investigation of task workflow errors and a visible place to inspect them.
UX-CC-W4/W5: after a failed workflow decision, the operator must be able to find what stopped and
what to inspect without replaying the operation. CC-INV-03/04/06 apply: failure is not success, a
display refresh does not retry work, and a suppressed notification does not erase failure evidence.

The supporting `taskflow` domain owns failure classification and the recording use case. Session
storage persists a safe `taskflow.failure` event and a bounded latest snapshot in metadata
`taskflow_last_failure`: version, operation, reason, status and observed_at (epoch seconds).
It does not duplicate Actio task state or claim that the failure is still active or has recovered.
The existing human-response notification guard remains authoritative; recording happens before it.
Raw exception messages, credentials, task content and response bodies never enter the snapshot.
The existing redacted diagnostic builder supplies the protected server log, including runtime failures.
Persistence failure is logged safely and does not suppress the existing notification path.

The `http-interface` and `session-message-webui` adapters display the failure:

- Taskflow overview shows a readable, allowlisted reason and guidance for failed reads. It keeps
  the last successful rows visibly stale, and does not show an empty success state after an initial failure.
- `/sessions/:id/logs` shows the latest workflow failure above the transcript, with time, operation,
  code and guidance. It explicitly labels resolution as unconfirmed; reloading is read-only.
- Existing session authorization and team/subsidiary boundaries apply. No global failure endpoint
  or cross-session aggregation is added. Unknown error payloads produce fixed generic guidance.

Observed during investigation: runtime `revisor-notice` failures were logged only as
`taskflow_internal_error`; later overview returned `actio_unavailable`, and task registration/listing
logged `TypeError: fetch failed` with `ECONNRESET` / `ECONNREFUSED`. This does not prove the cause
of older failures. The display change does not repair or restart dependencies and does not replay writes.

Acceptance: failures are retained even when notification is suppressed; diagnostics exclude raw
secrets; scoped session reads expose the safe snapshot; UI shows safe guidance for known and unknown
errors; stale rows and unconfirmed recovery are explicit. Tests cover the runtime boundary and both
UI surfaces. Runtime tests and production reflection remain subject to the existing permissions.
Rollback: revert this change; old readers safely ignore the extra metadata/event kind.

## CC-TF-READ-01 / CC-TF-READ-02

Actio 参照 `actio:a15f5e8a-83d3-40f7-9c0a-7fe2e96e4ecf`。
UX-CC-W4/W5、CC-INV-03/04。オペレーターが一覧を更新して Actio の応答が途切れたとき、
どこまで確認できたかと次の操作が分かる。タスクの状態は Actio が所有し、Cc の一覧は取得時点の読み取り結果を表示する。

- CC-TF-READ-01。GET が応答待ちの上限（既定 10 秒）に達した場合は `actio_read_timeout`、
  接続失敗は `actio_unreachable`。一覧を更新すれば再取得できる。POST/PATCH を送信した後に応答を
  確認できなければ既存の `actio_outcome_unknown` として同じ依頼 ID で照合する。
- CC-TF-READ-02。同じ一覧の継続ページで通信またはページ応答の形式に問題が発生した場合、
  `GET /v1/taskflow/overview` は検査済みの行と取得分の件数を HTTP 200 で返し、
  `partial_reason` に固定の理由コードを付ける。先頭ページの失敗や所有範囲を確認できない場合はエラーを返す。
  Web の両一覧は部分取得を明示し、取得分が 0 件でもタスクが存在しないと断定しない。
  作業候補選定や作成時の重複照合に使う一覧は、全ページの取得を引き続き要求する。

復旧は一覧の再取得。スキーマや保存データの移行は不要で、変更はコミットの revert で戻せる。

## CC-TF-READ-03

Actio 参照 `actio:6376af7d-d727-47be-be85-99f05e140ae2`。
UX-CC-W4/W5、CC-INV-02/04。管制オーバービューを開いた担当者は、Actio の応答を待ち続けずに最後の一覧と更新状況を確認できる。
Actio がタスクを所有し、Cc の taskflow はプロセス内の一覧スナップショットを所有する。

- `GET /v1/taskflow/overview` はプロジェクト範囲ごとの一覧を使い、組織・チーム・状態の絞り込みを応答時に適用する。取得から 30 秒経過した場合は手元の一覧を即時返し、バックグラウンドで更新する。Actio 一覧の更新は全範囲を通じて同時に 1 本とする。
- 初回は最大 400 ms だけ取得を待つ。未取得時は `fetched_at: null` とし、取得中か取得失敗かを表示する。応答の目標は 1 秒以内。
- `fetched_at` は表示中の取得結果の時刻（ISO 8601）。`refreshing`、`stale`、`refresh_error` は更新状態を示す。通信・時間切れ・部分取得では最新の完全な一覧を保持する。完全な一覧がまだない場合は CC-TF-READ-02 の検査済みの部分一覧を表示できる。所有範囲の検査に失敗した一覧は公開しない。
- 回帰検査（Actio `actio:b83d93f2-145b-41f1-9b10-38a2bc3df0d3`）では、偽の時計で更新期限と再試行期限を進め、更新中と更新完了後を区別して、部分取得・時間切れの前後で完全な一覧と取得時刻が保持されることを確認する。
- Cc で確定した作成・状態変更は該当範囲の一覧に即反映し、一覧全体の取得時刻を維持する。変更前に始まった一覧の更新で確定結果を上書きしない。タスク本文の取得や作業候補選定には現行の直接読み取りを使う。
- 管制の Actio タスク欄は取得時刻と古さを表示し、件数が未確認の場合は空の一覧を確定表示しない。
- ブラウザーから Cc への取得が一時的に失敗した場合は、[CC-V5-INV-09](control-cards.md) に従って再接続中と表示し、最後に受け取った一覧と取得時刻を保持する。再接続時に一覧を読み直す。

復旧は次回の一覧取得。プロセス終了時に一覧は破棄され、永続データの移行は不要。変更はコミットの revert で戻せる。
