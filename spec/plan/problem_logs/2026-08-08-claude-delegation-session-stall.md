# Claude Delegation Sessions Stall in Invisible Permission Waits

- Date: 2026-08-08
- Status: correction prepared; deployment/build still required for Lictor source
- Area: Lictor permission proxy / Concordia Delegation lifecycle
- Severity: high — implementation sessions stop for up to ten minutes per tool call and completed work can remain reported as running

## Summary

This is a regression in the Claude Delegation execution path. A Claude session reports `permissionMode: "auto"`, but Lictor classifies that value as a human-confirmation request. The delegated session then waits for a response that is not visible to the user when permission cards are disabled. This makes the session appear non-working even though the model has already selected a tool.

## Evidence

- Claude session `3f7c00eb-f19b-4ebd-9ce0-9d05e6feddb6` recorded `permissionMode: "auto"` on 2026-08-08.
- The same session's `PreToolUse:Bash` permission hook took `602053` ms and returned `permissionDecision: "ask"` with `human confirmation timed out` at `2026-08-08T11:35:42.282Z`.
- Across 12 affected Claude session transcripts after the permission-proxy change, the same invisible timeout occurred 151 times for a summed `90,735,720` ms of blocked tool time. This is not an initial-turn or cold-start delay.
- The Lictor source only treats `acceptedEdits`, `bypassPermissions`, and `dontAsk` as automatic permission modes. `auto` is therefore classified as `user-confirmation`; Bash is also always classified as `user-confirmation`.
- The injected hook matches `Bash|Edit|Write|MultiEdit|NotebookEdit|Read|Glob|Grep|mcp__.*` and has a 610-second timeout, so an unanswerable request serially blocks normal tool work.
- The same session recorded project-relative hooks that do not exist (`Concordia/.claude/hooks/harness-guard.mjs` and `harness-gate.mjs`) at `2026-08-08T11:25:40Z`. They were non-blocking, but demonstrate stale/misaligned session hook wiring.
- Concordia health on 2026-08-08 reported `delegation-run-watchdog` halted after five failures: `no such column: watchdog_last_check_at`. This leaves status stale but is not on the blocking execution path.
- Active Opus delegation run `8fb27122-4a8b-4ad1-be93-46508f55e1df` was spawned with `--model claude-opus-5 --effort medium`; it proves the model and effort delegation arguments were applied for that run. Its child session later ended while the run remained `running`.
- The active Opus templates had only a top-level `reasoning_effort=medium`; the launcher reads `runtime_options`, so empty runtime options still fell back to the source default `high`. Both active templates were normalized to `runtime_options={"effort":"medium","thinking":false}`.

## Regression Context

The permission classifier expects pre-existing automatic-mode identifiers, while the current Claude Code session record reports `auto`. Permission cards default to disabled in Concordia's Discord configuration, so the ten-minute confirmation path has no practical responder. The lifecycle watchdog schema mismatch prevents stale runs from being reconciled after the session exits.

## Cause

The leading cause is a contract mismatch between Claude Code's current `permissionMode` value and Lictor's permission classifier, combined with a policy that routes Bash to human confirmation even when the user has selected automatic execution. The UI path for replying is disabled or not surfaced, turning a safety wait into an invisible stall.

Independently, the running Concordia process has an unreconciled database schema for the delegation watchdog. This leaves stale status in the monitor and hides whether the model actually finished or was blocked. Re-enabling that watchdog currently creates an auto-mode permission-dialog regression; its existing correction is deliberately separate from this incident.

## Fix Requirements

- For the current Claude `auto` permission mode, return no Lictor hook decision and let Claude Code apply its native configured auto policy immediately. Merely adding `auto` to the old deferred classifier would still invoke a second coordinator wait.
- Preserve explicit human confirmation for modes that are not automatic and for operations outside the user's configured auto-execution policy.
- Do not register an interactive permission wait unless an actionable response channel is enabled and reachable; emit an observable reason instead.
- Reduce the timeout or bypass the proxy for auto mode so a single tool cannot block an implementation session for ten minutes.
- Do not re-enable `delegation-run-watchdog` as part of this fix; validate its separate correction before any later restart.
- Keep Opus Delegation explicit: `model=claude-opus-5`, `effort=medium`, and extended thinking disabled.

## Verification

- Add a Lictor regression test with `permission_mode: "auto"` that proves the hook emits no Lictor decision and does not contact the coordinator.
- Add a test that a missing/disabled permission-response channel fails visibly or follows the explicit auto policy rather than waiting ten minutes.
- Keep watchdog migration/startup verification in its separate correction, including the auto-mode dialog regression.
- Validate one fresh Opus Delegation run: its spawn arguments, thinking-disable environment, first tool latency, and terminal run status must all be observable.

## Follow-up

- Inspect the deployed Lictor binary path and ensure it is built from the source that contains the permission fix.
- Remove or correct stale project-relative harness hooks in the effective Claude settings for delegated sessions.
- Record the final policy decision for automatic Bash execution, rather than relying on an implicit hidden confirmation path.
