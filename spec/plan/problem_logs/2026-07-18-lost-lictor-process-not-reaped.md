# Lost session leaves a live Lictor process tree

- Date: 2026-07-18
- Status: fixed in working tree
- Area: session process lifecycle / reaper
- Severity: sustained CPU and memory growth during long host uptime

## Summary

This is a recurring process-lifecycle regression. A session can remain `status=lost` while its recorded `metadata.lictor_pid` and descendant Codex/Claude/Node processes are still alive. The existing reaper intentionally treated every lost session as live forever, so cleanup happened only after abandonment/purge removed the row.

## Evidence

- Pre-reboot host metrics on 2026-07-18 showed long-lived Lictor trees with up to 136 descendants and host CPU at 100% during nested spawn fan-out.
- Post-reboot metrics still contained two lost sessions with live PIDs, 11-15 descendants, and about 0.7GB RSS each.
- `src/control/reaper.ts:liveSetsFromRepo()` added every lost session PID to the protected live set without a time limit.

## Regression Context

Lost sessions remain recoverable by heartbeat/WS traffic (`reviveIfLost`). Earlier fixes therefore protected all lost rows from reaper kills to avoid false-positive termination. That protection had no upper bound and allowed genuinely disconnected process trees to accumulate.

## Cause

The generic orphan classifier could only distinguish referenced versus unreferenced PIDs. Since a lost row still referenced `lictor_pid`, the process was never an orphan until the row was purged.

## Fix Requirements

- Preserve a bounded lost recovery window.
- After the window, kill only when the row is still lost, `ws_clients=0`, the PID is unchanged, and the OS command line identifies that PID as `lictor.mjs`.
- Re-read the authoritative row immediately before issuing taskkill so a revived session is skipped.
- Keep generic orphan classification unchanged so detached agent-client cleanup does not double-kill the lost Lictor tree.

## Verification

- A stale, disconnected lost row with a matching Lictor PID is killed.
- Fresh lost, active, WS-connected, PID-mismatched, and revived rows are not killed.
- Periodic/admin reaper wiring returns the lost cleanup result.
- TypeScript, dependency-boundary, and targeted Vitest checks must pass.

## Follow-up

Deploy through the normal Excubitor claim/restart flow, then confirm host metrics no longer report lost sessions with live process trees after the configured grace.
