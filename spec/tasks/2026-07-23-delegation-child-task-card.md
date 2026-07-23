# Route provider child tasks through Cc Delegation

## Goal

When a Cc-wrapped Codex or Claude session needs a sub-agent or child task, it must
launch that work through Cc Delegation and expose the invoked task on the parent
session's information/status card.

## Required behavior

### Child launch contract

- Cc Delegation is the provider-neutral child-task primitive.
- Delegation context/manual text explicitly tells Codex and Claude not to use
  provider-native sub-agent/child-task launch primitives when Cc Delegation is
  available.
- The session uses `delegation_list_templates` and `delegation_invoke` (or the
  equivalent Cc HTTP endpoint) with `spawn: true`.
- `parent_session_id` is always recorded. The Delegation MCP adapter defaults a
  missing value from `CONCORDIA_SESSION_ID`, which Lictor already exports to the
  wrapped provider process. An explicit caller value still takes precedence.
- The invoked task must be narrow and human-readable in the run arguments:
  `task`, `problem`, `design_path`, or a dedicated child-task summary.
- The spawned Delegation run remains the source of truth for child session and
  status. Do not create a second shadow child-task table.

### Parent information card

- The parent session status snapshot includes recent runs whose
  `delegation_runs.parent_session_id` matches the session.
- Each displayed row contains a short task label, run/call identity, child session
  short ID when claimed, and current status.
- Extract task labels from known run arguments without rendering secrets or the
  complete prompt. Bound individual and aggregate Discord field lengths.
- Refresh the parent information card when a child run is invoked/queued,
  claims a child session, or reaches a terminal status. Periodic reconciliation
  remains a fallback.
- Runs remain visible after completion/failure so the card records what the parent
  called.

## Design constraints

- Put run-to-card projection and task-label extraction in a pure focused module.
- Extend the existing `ChatReadModel`/status snapshot; do not query the database
  directly from the Discord renderer.
- Add an explicit run lifecycle event rather than coupling the Delegation API to
  Discord.
- Keep provider wording shared so Codex and Claude follow the same contract.

## Acceptance

- Tests prove MCP invocation inherits `CONCORDIA_SESSION_ID` only when
  `parent_session_id` was omitted.
- Tests prove the Delegation context instructs provider-native child tasks to use
  Cc Delegation.
- Tests cover safe task-label extraction and truncation.
- Status-card tests render queued/running/completed/failed child runs with task and
  child identity.
- Event tests prove the parent card refresh trigger is independent of Discord API
  implementation.
- Production and test type checking pass.
