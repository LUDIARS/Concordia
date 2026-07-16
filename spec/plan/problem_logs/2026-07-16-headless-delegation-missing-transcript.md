# Headless Codex Delegation Does Not Persist Transcript

- Date: 2026-07-16
- Status: fixed
- Area: Delegation / Codex session spawn
- Severity: high — delegated work completes but the Delegation UI has no working log

## Summary

This is a regression in Delegation observability. Codex implementation runs completed and created pull requests, but their Delegation sessions contained no transcript frames. The user requested that Codex use the normal Delegation session path instead of the headless worker.

## Evidence

- Delegation runs `44d316e5-b8fc-472b-ae5d-9be0821b9fcd` and `8eca4967-d226-4cab-9098-94edf8edd0cb` both reached `completed`.
- Their child sessions recovered Codex rollout files containing 314 and 364 JSONL lines.
- `GET /v1/sessions/:id/transcript` returned `total: 0` for both sessions.
- `DelegationService.invoke()` selected `spawnCodexExecWorker()` only for provider `codex`.
- `tools/concordia-codex-worker.mjs` registered the session and terminal status but never posted `/transcript-frame`; its final stdout was discarded because the detached spawn used `stdio: "ignore"`.

## Regression Context

The headless worker was introduced to avoid interactive trust and approval prompts. Lictor now provides the normal Codex Delegation path through its App Server transport, including authoritative thread binding, prompt submission, and transcript persistence. Keeping the old provider-specific spawn bypassed that path.

## Cause

Concordia routed Codex Delegation through a provider-specific headless worker while every other provider used `spawnSession()`. The headless worker implemented lifecycle reporting but not transcript relay.

## Fix Requirements

- Route Codex through the same normal Lictor Delegation session spawner as other providers.
- Preserve the rendered prompt file and Delegation run metadata environment variables.
- Keep explicit dependency-injected spawners working for tests and alternate composition.
- Remove the unused Delegation-only headless spawn adapter so it cannot be selected accidentally.
- Retain the manual one-shot worker as a separate diagnostic/tooling command.

## Verification

- Regression test proves the default Delegation spawner is `spawnSession()`.
- Delegation and spawner tests: 51 passed.
- Lint and build passed.
- Full suite: 1,602 tests passed in the sandbox; the only EPERM fixture test passed when rerun with its required access to the user Claude-log directory (1,603 total verified).
- After deployment, launch one Codex Delegation from the project root through Excubitor-controlled Concordia and confirm transcript frames appear in the Delegation session.

## Follow-up

Live verification requires a Concordia testing claim and must use the project root service managed by Excubitor. Do not start Concordia from this worktree.
