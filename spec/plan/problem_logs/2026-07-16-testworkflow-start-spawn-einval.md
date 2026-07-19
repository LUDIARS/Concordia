# TestWorkflow Start Fails With HTTP 409 on Windows

- Date: 2026-07-16
- Status: unresolved
- Area: TestWorkflow / confirm start / Windows build launcher
- Severity: high — human verification cannot enter the confirming state

## Summary

At 2026-07-16 17:14:00 JST, pressing `テスト開始` for Concordia PR #344 returned `テスト開始に失敗: HTTP 409`. The repository switch completed, but the build process could not be created on Windows.

## Evidence

- Cc logged at 2026-07-16 17:14:00.866 JST:

  `ビルドに失敗: spawn EINVAL`

- The same request logged `POST /v1/confirm/start status=409 duration_ms=2174`.
- The main Concordia folder was clean and had already switched to `concordia-test/pr-344` at commit `7b2a9e8`, so dirty-worktree rejection and PR checkout failure were not the cause.
- `src/release/build.ts` uses `execFileAsync("npm.cmd", args, { shell: false })` on Windows.
- A service-free minimal reproduction under Node.js v24.14.1 failed identically:

  `execFile("npm.cmd", ["--version"])` -> `Error: spawn EINVAL`

- The safe launcher shape succeeded:

  `execFile(ComSpec, ["/d", "/s", "/c", "npm.cmd", "--version"])` -> npm `11.11.0`

- `src/discord/commands/_util.ts` reads only an `error` field from non-2xx JSON. The confirm API returns its actionable detail in `message`, so Discord collapses the real cause to the generic `HTTP 409` text.

## Regression Context

The Windows-specific comment in `src/release/build.ts` claims that selecting `npm.cmd` avoids shell issues, but the current Node runtime rejects direct `.cmd` execution. Tests mock the build boundary and did not exercise the real Windows launcher.

## Cause

Primary cause: direct `execFile` execution of the `npm.cmd` batch shim on Windows raises `spawn EINVAL` under the deployed Node.js runtime.

Secondary cause: the Discord HTTP helper discards the confirm API's `message` field on non-2xx responses, hiding the actionable error from the user.

## Fix Requirements

1. Introduce a single cross-platform npm launcher that uses `ComSpec` for `.cmd` execution on Windows and direct argv execution elsewhere.
2. Keep arguments structured and avoid concatenating untrusted text into a shell command line.
3. Add a Windows-aware launcher test or dependency-injected process-runner test that would catch `spawn EINVAL`.
4. Preserve the API's `message` field for non-2xx Discord replies so the real failure is shown.
5. Ensure a failed build leaves the confirm run retryable and the Test forum state consistent.

## Verification

- Unit-test both `npm ci` and `npm run build` launcher arguments for Windows and non-Windows paths.
- Confirm a real `npm --version` or repository build can be spawned through the launcher without starting a service.
- After the fix is deployed, use the Test forum button and verify the run reaches `confirming`, the Discord tag changes to `確認中`, and the detailed error is shown if any stage fails.
- Any live retry must use the Concordia project folder and Excubitor, with testing claim/release.

## Follow-up

The failed attempt left the main Concordia folder on `concordia-test/pr-344`. Do not switch it manually while another test session may own it; recover or retry through the TestWorkflow after the launcher fix.
