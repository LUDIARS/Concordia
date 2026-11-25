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
