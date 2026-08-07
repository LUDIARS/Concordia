# Test Forum session lacks merge token and can spawn duplicates

- Date: 2026-08-07
- Status: superseded — session reuse fix retained; token delegation reverted
- Area: Discord Test Forum / session spawn / Revisor authorization
- Severity: high — verified work cannot be merged from its assigned session, and follow-up conversation may start duplicate sessions

## Summary

This is a workflow regression. A Test Forum verification session is started without the Revisor workflow token required by mutation endpoints. When the user continues the conversation in the same Test Forum thread before session binding completes, Concordia can request another session instead of reusing the first one.

## Evidence

The user reported the session-visible failure on 2026-08-07:

> Revisor のマージ API はこのセッションに委譲されていない workflow token を必須としており、実行は `401 unauthorized` で拒否されました。

The user also reported that posting in the same Test Forum thread starts a separate session. Relevant boundaries are `src/discord/test-forum-actions.ts` (`requestTestSpawn`), `src/discord/test-forum-message.ts` (`handleTestForumMessage`), and `src/api/register-core.ts` (`POST /v1/admin/spawn-session`).

## Regression Context

Existing thread-message code injects into `surface.session_id` when it is active, but `surface.session_id` is only written after `session.started`. The surface remained `candidate` during that interval, so another message could pass the candidate check and invoke the spawn endpoint again. Revisor token storage and Cc-owned API clients existed, but the token was not delegated across the Test Forum child-session spawn boundary.

## Cause

1. The Test Forum spawn environment contained model/runtime variables but not the Cc-managed Revisor workflow token.
2. There was no persisted launch-reservation state between the synchronous spawn request and asynchronous `session.started` binding.

## Historical Fix Requirements

The token-related requirements below describe the first fix and are rejected by the superseding incident record. The session-reuse requirements remain valid.

- Delegate the Revisor workflow token only to Test Forum sessions, without exposing it in API responses, prompts, or logs.
- Fail before spawn if the token is unavailable.
- Atomically reserve a Test Forum surface before requesting spawn.
- While the reservation awaits `session.started`, do not spawn again from button presses or thread messages.
- After binding, route thread messages to the existing session through `session.inject`.
- Roll a reservation back when the synchronous spawn request fails.

## Verification

Regression coverage was added for token scoping/fail-fast behavior, atomic `candidate → starting → testing` transitions, concurrent start suppression, and thread-message wait/reuse behavior. Tests were not run in this session because the session policy forbids test execution without explicit user instruction.

## Follow-up

The token-delegation portion of this fix gave an interactive LLM session authority over Revisor mutations. That ownership model was rejected by neco on 2026-08-07 and is superseded by `2026-08-07-test-forum-llm-revisor-authority.md`. The persisted `starting` reservation and same-thread session reuse remain valid.
