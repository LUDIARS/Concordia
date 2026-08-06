# Test temporary cwd spawn race

- Date: 2026-07-25
- Status: fixed (runtime configuration repaired and registration verified)
- Area: admin session spawn / test harness
- Severity: medium (test runs can open an unintended terminal and report a misleading launch error)

## Summary

Regression: a Concordia API test passed its temporary `concordia-test-logs-*` directory to a real Windows Terminal launch. The test cleanup then removed that directory before Windows Terminal resolved its `-d` working directory.

## Evidence

- User-visible Windows Terminal error: `2147942667 (0x8007010b)` while launching `lictor codex -c model_reasoning_effort="xhigh"`.
- `0x8007010b` is `ERROR_DIRECTORY` (267), “The directory name is invalid.”
- The rejected cwd was `C:\\Users\\raury\\AppData\\Local\\Temp\\concordia-test-logs-fQArnD`.
- `tests/helpers/db.ts:makeTestDir` creates and registers deletion of this exact directory prefix.
- `tests/admin-api.test.ts` configures this temporary directory as the workspace root, while `src/api/register-core.ts` directly called `spawnSession` instead of an injected test double.

## Regression Context

The test harness already injects a delegation spawn stub. The no-prompt admin-spawn route bypassed that boundary, so the suite could create detached interactive terminals.

## Cause

`registerCoreRoutes` imported and called the production `spawnSession` function directly. `makeTestApp` had no corresponding dependency override for those direct admin-spawn paths.

## Fix Requirements

- Make the core admin-spawn launcher injectable, with the production launcher as its default.
- Configure `makeTestApp` with a no-op session-spawn stub.
- Add a regression test that verifies the temporary workspace cwd is received by the stub, without launching Windows Terminal.

## Verification

- Run the focused admin API test file.
- Run TypeScript/build validation for Concordia.

## Follow-up

Inspect other test helpers that create temporary directories before adding new interactive process-launch paths.

## Follow-up Incident (2026-07-25)

After the fix was merged, Concordia accepted a `codex-5-6-sol` spawn (`pid: 61072`) but no session registered within 12 seconds.

### Cause

Concordia was configured for Lictor development mode with `E:\Document\Ars\Lictor` as its launcher path. That checkout had an incomplete `node-pty` installation, so the spawned Lictor process could not load its CLI. A clean, built Lictor runtime was prepared at `E:\Document\Ars\.wt-Lictor-runtime-repair`, and the live admin setting was changed to use that path.

### Verification

- `lictor --version` and a Lictor-wrapped `codex --version` completed successfully from the repaired runtime.
- Retrying `codex-5-6-sol` registered `lictor-1818fcfe-8433-487c-85a6-45eb40572dd2` with Concordia in about 1.7 seconds; the session is active with a published Lictor sidecar port.
- The first polling check looked for a non-existent `target_provider` field. Direct session lookup and Concordia's request log confirmed the successful registration.
