# Concordia runtime build regression blocks restart

- Date: 2026-08-08
- Status: fixed in working tree
- Area: backend bootstrap / TypeScript runtime types
- Severity: high — Excubitor cannot start the current Concordia main runtime

## Summary

This is a regression in the current `main` runtime build and startup path. Excubitor restart
requests spawned Concordia processes that could not be verified, so the service remained
outside Excubitor's managed state. The first attempted process failed because its runtime
dependencies were absent; after dependencies were restored and the build was repaired, the
process still stopped on a migration checksum mismatch.

## Evidence

- Excubitor rejected restart verification for Concordia child PIDs 38548 and 26924.
- `data/process-logs/concordia.err.log` recorded
  `ERR_MODULE_NOT_FOUND` for `@hono/node-server` and a missing
  `dist/skills/concordia.md` runtime asset.
- After `npm install --include=dev`, `npm run build` reported:
  - missing `../control/test-session-workflow-token.js` from
    `src/api/register-core.ts`;
  - undeclared `unsubTestingRelease` and `unsubLocalPrSubmit` cleanup callbacks in
    `src/bootstrap/core.ts`;
  - missing Fetch API members such as `Response.status` and `Response.json` across
    the backend because `tsconfig.json` omitted the `DOM` library.
- The process output recorded `migration checksum mismatch at 41:baseline-v41`.
  The persisted ledger checksum matched the pre-merge baseline. The latest source had
  appended `discord_pending_questions.discord_channel_id` to `COLUMN_ADDITIONS`, which
  is part of the already-applied baseline checksum.

## Regression Context

The Test Forum workflow-token helper was deleted when Revisor mutations became
system-owned, but its import remained in the current merge. The workflow binding
registry also replaced the two direct event subscriptions, while their old resource
cleanup entries remained. Both are incomplete migration remnants.

## Cause

The TypeScript configuration declared only `ES2023` despite the Node backend using the
standard Fetch API types. Separately, two refactors removed implementations without
removing their stale references. A later merge also changed the mutable source used by
the applied migration 41 baseline instead of creating a new numbered migration.

## Fix Requirements

- Remove references to deleted token-delegation and direct subscription APIs.
- Let `WorkflowBindingRegistry` remain the sole owner of those subscriptions.
- Include the standard Fetch API type library in the backend TypeScript build.
- Keep runtime skill synchronization as part of the ordinary build before a future
  Concordia restart.
- Move `discord_pending_questions.discord_channel_id` into a new idempotent migration and
  leave migration 41's ledger source untouched.

## Verification

`npm run build` must finish without TypeScript errors. The repaired service must then start
through Excubitor from the project main checkout and release its testing claim. No unit or
integration test was run in this session because the session policy requires explicit
authorization for tests.

## Follow-up

After the fix is reviewed and merged, restore Concordia through Excubitor from the
project main checkout with a Concordia testing claim and release.
