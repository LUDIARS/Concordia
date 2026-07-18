# Session-end completion raced the ended-session reaper

- Date: 2026-07-18
- Status: fixed in working tree
- Area: session process lifecycle / reaper
- Severity: session logs, memory updates, and handoff work could be interrupted

## Summary

This was a process-lifecycle regression. Concordia waited for the AI-side `session-end` completion signal before intentionally stopping Lictor, while the generic reaper could stop the same ended process tree after a shorter fixed grace period.

## Evidence

- `SESSION_END_DONE_TIMEOUT_MS` allowed ten minutes for `POST /v1/sessions/:id/session-end-done`.
- `CONCORDIA_REAPER_ENDED_GRACE_SEC` protected ended sessions for only five minutes.
- `tests/reaper.test.ts` tested the five-minute boundary in isolation but did not assert the cross-component completion invariant.

## Regression Context

The grace was introduced as a safety valve for session-end work, but completion signaling later became the authoritative lifecycle boundary. Both mechanisms remained enabled with independent time windows.

## Cause

Generic orphan recovery inferred process ownership from elapsed time after `status=ended`. It did not know whether the AI-side session-end workflow had actually reported completion.

## Fix Requirements

- Stop Lictor and agent-client PIDs only after the durable session-end completion marker is present and `session-end-done` is received.
- Never reap an ended session merely because time elapsed.
- If completion never arrives and traffic plus WS connectivity stop, transition the pending ended session to lost and use the lost-session reaper.
- Keep the completion marker durable across Concordia restarts and retain it when process stopping fails.

## Verification

- DELETE records a durable pending marker; `session-end-done` clears it only after successful or already-complete PID stopping.
- `session-end-done` without a pending marker cannot stop an active session.
- Incomplete pending sessions become lost after their normal liveness threshold.
- Generic reaper protects ended PIDs without a time limit; lost reaper still protects active and ended PID reuse.
- TypeScript, dependency-boundary, and targeted Vitest checks must pass.

## Follow-up

Deploy through the Excubitor claim/restart flow and observe one real session-end completion plus one controlled lost fallback.
