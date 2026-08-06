# Session-end reports an answered question as pending

- Date: 2026-07-24
- Status: fixed in working tree
- Area: session-end report / summary flags
- Severity: medium; completed human decisions are reported as unresolved

## Summary

Session-end reported that the merge policy for Anatomia PR #106 and #107 was
still undecided, even though the associated Concordia question had been
answered and both PRs had already been merged. This is a latent reporting
defect: the durable question state was correct, but the generated handoff was
stale.

## Evidence

- `discord_pending_questions.id=1190` was posted at
  `2026-07-24 03:05:22 JST`.
- The row was answered at `2026-07-24 06:18:02 JST` with answer index `0`,
  `両方マージして (推奨)`.
- `session_events` contains both `pending_question` and the matching
  `question_answered` event for question `1190`.
- Anatomia PR #106 was merged at `06:20:29 JST`; PR #107 was merged on top of
  it at `06:29:27 JST`.
- `src/report/summary-flags.ts` selected `pending_question` events for the
  Sonnet classifier but omitted `question_answered` and `question_resolved`.

## Defect Context

Pending-question history is intentionally retained for audit. The summary
classifier treated that historical event as current state because completion
events were not part of its input or preprocessing.

## Cause

`detectSummaryFlags` filtered session events by kind and passed every retained
`pending_question` to the classifier. It did not reconcile those rows against
matching completion events or the durable question row before asking the model
to identify human actions. The durable row update and completion event append
are separate operations, so event-only reconciliation would still leave an
abnormal-exit gap.

## Fix Requirements

- Reconcile each pending question with matching `question_answered` /
  `question_resolved` events and the durable question row.
- Replace completed pending entries with an explicit completion marker after
  ordinary events, so stale prompt text cannot outweigh the current state.
- When a durable state reader is available, require an answered row owned by
  the same session; event-only completion is a fallback for legacy callers.
- Keep completion markers status-only and separate from the ordinary 60-event
  budget, avoiding answer-content exposure and loss of current blocker events.
- Preserve genuinely unanswered questions.
- Keep all source events in storage for audit; only the derived summary excerpt
  changes.
- Bound the excerpt to 60 entries with stable `(ts, id)` ordering.
- Cover answered, locally resolved, durable-state-only, unresolved, mixed,
  event-window, ordering, and ID-normalization cases with deterministic tests.

## Verification

- Run the focused `summary-flags` unit tests.
- Run Concordia type checks and the complete test suite.
- Confirm the production question row remains answered; do not rewrite or
  delete its audit events.

## Follow-up

No additional answer or resolve API call is required for question #1190.
