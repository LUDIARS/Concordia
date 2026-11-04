# Bound automatic followups without progress

Instruction: neco, 2026-11-04, enforce the no-progress stopping rule.
Task: actio:12c26272-6ffb-4c96-b0cc-9706cf0b55b4

## Design and acceptance
The autonomous-continuation domain owns the persisted strike limit. All state classifications count toward the existing limit of three. At the limit, do not fetch external work state. The existing progress-notification adapter resets the count only for newer notification timestamps; ordinary assistant responses and state reclassification do not reset it. Preserve explicit human gates and the separate changed-only human-todo reporting path.

AI guidance requires stopping after one no-action report; the three-message server ceiling is not permission to repeat that report. Regression coverage includes both CLI providers, persisted strikes after restart, alternating task-active/merge-confirmation, newer versus replayed notifications, and retained human gates. Source/tests are registered in cc.acceptance.json.

## Validation and operational boundary
Session does not run tests or restart services. Revisor must execute registered tests before merge. No dependency, install hook, credentials, external endpoint, or startup communication is added. Changes use existing event subscriptions and metadata APIs only; no new package is needed. Existing runtime dependencies are unchanged.

## Recovery
Revert this change through the normal review workflow to restore previous continuation policy. Existing metadata is compatible; no migration or deletion is required. Runtime reflection remains unverified until the normal deployment process applies the merged changes.
