# Task workflow failure visibility

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
