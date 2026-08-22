# Revisor local PR merge failure leaves shared checkout conflicted

- Date: 2026-08-22
- Status: unresolved
- Area: Revisor local PR merge / Concordia checkout lifecycle
- Severity: high — the shared Concordia checkout cannot be used safely after a rejected merge

## Summary

This is a regression/incident in the Revisor local PR merge path. A human-authorized merge of
Concordia local PR #950 was rejected for conflicts, but the repository checkout at
`E:\Document\Ars\Concordia` was left detached with unresolved index conflicts instead of being
restored to its pre-merge state.

## Evidence

- At 2026-08-22 18:51 JST, `POST /v1/prs/local/<id>/merge` for local PR #950 returned no
  successful result. The Revisor read model then changed #950 from `test_ok` to
  `action_required` and reported conflicts in four files.
- Immediately afterwards, `git branch --show-current` in the shared checkout returned an empty
  branch and `HEAD` was `0ae9c081`.
- `git status --porcelain` included unresolved entries:
  - `DU src/api/delegation-staged-injection.test.ts`
  - `DU src/delegation/staged-followup.test.ts`
  - `DU src/delegation/staged-injection.test.ts`
  - `UU tests/delegation-regression.test.ts`
- The checkout also contains unrelated modified and untracked files, so an automated abort or
  reset would risk destroying another session's work.

## Regression Context

Local PR merge is expected to prepare an isolated merge candidate and leave the project checkout
unchanged on failure. The current behavior leaks the failed merge state into the shared checkout,
blocking later sessions and making subsequent PR operations ambiguous.

## Cause

The leading hypothesis is that the Revisor merge path performs conflict detection or candidate
assembly in the registered project checkout, or does not restore that checkout on every failure
path. The exact Revisor-side call path remains to be confirmed.

## Fix Requirements

The checkout isolation defect is on the Revisor side; Concordia only calls the merge endpoint and
cannot change how Revisor assembles the merge candidate. The requirements are split accordingly.

### Revisor (owner of the fix)

- Perform merge candidate creation exclusively in an isolated clone/worktree owned by Revisor.
- On conflict, timeout, exception, or cancellation, release all merge resources and leave the
  registered project checkout byte-for-byte and index-for-index unchanged.
- Refuse to start a merge against a dirty or already-conflicted checkout if isolation cannot be
  guaranteed.

### Concordia

- No change is required for the response contract. `POST /v1/prs/local/:id/merge` already returns a
  structured `{ error: "local_pr_merge_failed", reason, detail }` with `reason: "conflict"` via
  `classifyMergeFailure` (`src/api/prs.ts`, delivered by `spec/tasks/revisor-merge-feedback.md`).
  The empty result seen during the incident was observed at the caller, not produced by this
  endpoint; confirm the caller before treating it as a Concordia defect.
- Provide an explicit, separately authorized recovery procedure for the already-conflicted
  shared checkout; do not automatically reset or abort it while unrelated changes exist.

## Verification

- Revisor-side: add a regression test that merges a deliberately conflicting local PR against a
  dirty shared checkout and asserts that HEAD, branch, index entries, and working-tree files are
  unchanged, plus failure-path coverage for conflict, timeout, and unexpected exception cleanup.
  This cannot be covered by Concordia's registered tests.
- Concordia-side: `src/pr/revisor-merge-outcome.test.ts` and `src/api/prs.test.ts` already cover
  the conflict classification and the 502 response shape.
- No tests were run while recording this incident.

## Follow-up

- Identify the owner of the unrelated changes before cleaning the shared checkout.
- Repair and re-review #950 in its dedicated worktree after the shared checkout incident is
  contained.
