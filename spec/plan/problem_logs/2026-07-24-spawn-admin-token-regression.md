# Spawn session fails when admin authentication is unconfigured

- Date: 2026-07-24
- Status: unresolved
- Area: Concordia Web UI / admin API authentication
- Severity: high - session spawn is unavailable in a standard local Excubitor launch

## Summary

Regression: spawning from the Web UI fails with `spawn failed: authentication_not_configured` when `CONCORDIA_ADMIN_TOKEN` is not configured.

## Evidence

- User-visible error: `spawn failed: authentication_not_configured`.
- `web/src/api.ts` sends Web UI spawn requests to `POST /v1/admin/spawn-session`.
- `src/shared/admin-auth.ts` returns HTTP 503 with hint `set CONCORDIA_ADMIN_TOKEN` when the token is unset.
- `src/app.ts` applies admin authentication to `/v1/admin/*`.
- The comment in `src/api/register-core.ts` still describes this dashboard route as loopback-only with no bearer requirement.
- The hardening was introduced by `bbfa894` (`P0: harden Concordia trust boundaries (#380)`); the local Excubitor service environment has no `CONCORDIA_ADMIN_TOKEN` configured.

## Regression Context

PR #380 made mutation/admin APIs fail closed when no authentication is configured. The UI spawn path was left on an admin endpoint while its local-launch configuration was not updated.

## Cause

The leading diagnosis is an integration mismatch between the fail-closed admin middleware and the Web UI/Excubitor local deployment contract. `CONCORDIA_ADMIN_TOKEN` is distinct from the self-spawn token used by `/v1/spawn`.

## Fix Requirements

- Decide and document the supported local authentication contract for dashboard spawn.
- Configure and inject the admin token consistently, or route trusted local spawn through a separately authenticated capability path.
- Keep non-loopback/admin mutation endpoints fail closed.
- Update the stale loopback/no-bearer comment in `src/api/register-core.ts`.

## Verification

- A local Excubitor-managed Concordia launch can spawn a session successfully.
- An unauthenticated non-loopback admin spawn remains rejected.
- Add an integration test covering the UI spawn endpoint with the supported local configuration.

## Follow-up

Review other local testing/admin calls affected by the same token requirement, including claim/release operations.
