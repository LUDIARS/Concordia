# Discord Fable spawn reports success without a session

- Date: 2026-07-24
- Status: investigating
- Area: Discord `/spawn` delegation launch and Windows CWD handling
- Severity: high — a user receives a spawn-looking response but no session starts

## Summary

This is a regression report: Discord displayed `Spawned from claude-fable-5-impl (pid: 14420)`, but no child session was registered. The persisted delegation run for the attempted launch is `spawn_failed`, so no usable process or session was created.

## Evidence

- The latest `claude-fable-5-impl` run is `103b1880-7624-46be-93c1-e7d68c21a117`.
- It is recorded as `status=spawn_failed`, `spawn_pid=null`, `child_session_id=null`, and `triggered_by=web-spawn` (the shared admin spawn endpoint labels both dashboard and Discord callers this way).
- Its saved argument is `target_repo: E:DocumentArsConcordia`; the expected Windows path is `E:\\Document\\Ars\\Concordia`.
- The recorded error is `cwd does not exist: E:DocumentArsConcordia`.
- `src/discord/commands/spawn.ts` waits 12 seconds for a session and otherwise sends `Spawned from <template> (pid: ...)`. The completion response must therefore only be treated as a confirmed session when a child session/channel is actually observed.

## Regression Context

The Concordia process was restarted on 2026-07-24 after merges from both 2026-07-23 and 2026-07-24 became active. The path-removal behavior must be compared against that merge set, but the admin spawn route's template argument forwarding predates it (introduced on 2026-07-05). The 2026-07-24 platform-user authorization change rejects unauthorized users before this route; it does not explain a `cwd does not exist` error.

## Cause

The immediate cause is a malformed Windows path reaching delegation spawn. The leading hypothesis is that the Discord/template launch input path is being transported or normalized with backslashes treated as escapes before it reaches `DelegationService`. The exact transformation point is not yet confirmed.

Separately, the Discord success text is too optimistic: it can show a PID fallback even when no session is registered, and it does not present the persisted run failure to the user.

## Fix Requirements

- Preserve Windows absolute paths (including `\\`) from Discord `/spawn` input through template args, `cwd`, and `DelegationService`.
- Cover templates whose `default_cwd` is `${target_repo}`, including `claude-fable-5-impl`.
- Report `spawn failed` unless the API accepted the launch and a child session is registered; include the actionable backend error when available.
- Keep Discord, Web UI, Slack, MCP, and forum launch paths independently covered so a fix to one caller does not mask path corruption in another.

## Verification

- Add focused tests for an `E:\\Document\\Ars\\Concordia` target repository passed through each applicable launch boundary.
- Verify the resulting `delegation_runs.args_json` and `spawn_cwd` retain a valid Windows path.
- Perform one controlled Discord template spawn after the fix and confirm a child session/channel is registered.

## Follow-up

- Correlate the user-visible PID `14420` with the exact API response and run ID; do not treat the text as proof that a session started.
- Review all 2026-07-23 and 2026-07-24 first-parent merges that changed spawn, delegation, Discord, or serialization behavior before selecting the implementation fix.
- 2026-07-24 verification found the same success-looking result for `codex-5-6-sol` with no `project` or `cwd`. Its `${target_repo}` default was unresolved and silently fell back to the workspace root. Reject that request before `wt.exe` is launched.
