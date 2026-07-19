# Reaction Workflow Does Not Fire With an Empty User Allowlist

- Date: 2026-07-16
- Status: investigating
- Area: Reaction Workflow / Discord ingress authorization
- Severity: high — reactions appear accepted by Discord but no workflow action or acknowledgement is produced

## Summary

At 2026-07-16 17:13:33 JST, the user reported that Cc Reaction-Workflow appeared not to work. The live safety switch is enabled, but execution is deny-by-default and the deployed configuration has no observable Discord user allowlist. In that state every non-bot reaction is rejected before `ReactionWorkflowRunner.handle()`.

## Evidence

- `GET /v1/admin/reaction-workflow` returned `{ "enabled": true }`.
- `GET /v1/admin/reaction-mappings` returned 64 defaults and 2 overrides, so the action mapping is loaded.
- `Excubitor/catalog/services.yaml` does not set `CONCORDIA_REACTION_WORKFLOW_DISCORD_USERS` or `CONCORDIA_REACTION_WORKFLOW_SLACK_USERS` for the `concordia` service.
- `Concordia/.env` has no matching reaction-workflow allowlist entry, and the investigating shell inherited no Discord allowlist entries.
- `src/shared/reaction-workflow-auth.ts` defines an empty allowlist as deny-all.
- `src/bootstrap/core.ts` checks the process env directly for every Discord trigger.
- `src/discord/reactions.ts` calls the workflow only when `isWorkflowUserAllowed(user.id)` returns true; otherwise it logs `workflow ignored unauthorized` and returns without an acknowledgement.

The admin API currently exposes only the enabled flag, not whether any platform user can actually pass the gate. The exact live process env is not exposed, so the missing/empty runtime allowlist remains the leading diagnosis rather than a directly read process value.

## Regression Context

This is a silent configuration regression: the Rules UI can show Reaction-Workflow as enabled while the independent allowlist makes it unusable. The enabled state alone therefore misrepresents operational readiness.

## Cause

Leading cause: Reaction-Workflow is enabled in `AdminState`, but its Discord authorization source is a separate process environment variable that is absent from the authoritative Excubitor service definition. `isReactionUserAllowed(undefined, userId)` is always false.

## Fix Requirements

1. Supply the intended Discord/Slack user allowlists through an authoritative deployment configuration path.
2. Expose a non-sensitive readiness signal (for example, configured entry counts) beside the enabled flag.
3. Warn clearly when Reaction-Workflow is enabled with an empty platform allowlist.
4. Keep deny-by-default authorization; do not replace it with an allow-all fallback.
5. Preserve exact-ID matching and add coverage for enabled-plus-empty, enabled-plus-allowed, and unauthorized cases.

## Verification

- Confirm the admin surface reports enabled and at least one configured Discord allowlist entry without exposing IDs.
- Add a reaction from an allowed Discord user and verify an immediate acknowledgement reply plus the expected inject/headless action.
- Add the same reaction from an unlisted user and verify no workflow execution and an explicit diagnostic log.
- No service restart or live reaction test was performed during this investigation.

## Follow-up

After configuration or code changes, restart only through Excubitor from the Concordia project folder, with `/v1/testing/claim` and `/v1/testing/release` around the test.
