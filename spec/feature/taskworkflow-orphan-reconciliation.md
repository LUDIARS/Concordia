# TaskWorkflow orphan thread recovery

- Value: UX-CC-W3 / UX-CC-W4 in spec/ux/product.md
- Contract: CC-DISCORD-TASK-ORPHAN-01
- Approved scope: 2026-09-27 neco requested investigation and remediation for thread 1545602528555569273.

## User state
A finished or vanished task must not appear to be running forever. A live task, human conversation or unverified outcome must not be erased or declared successful.

## Ownership and invariants
Session lifecycle and delegation repositories own their states. Discord integration owns only the forum projection. Reconciliation never changes run outcomes, session records, task completion or conversation content.

The existing DB-based sweeps cannot see a Discord thread whose binding has disappeared. Each runtime additionally enumerates its configured TaskWorkflow forum's active threads. It processes at most 25 old, unbound candidates per pass, rotating the cursor so unknown candidates cannot starve later threads. The cursor is only a scan optimization; Discord and Cc records remain authoritative across restarts.

Archive only when all conditions hold:
- Public, unarchived thread in the runtime's configured TaskWorkflow forum, at least one hour old.
- No channel binding or session binding, including a replacement binding.
- Starter is from this Cc bot or a webhook currently owned by it in that forum. Human-written lookalike text and other bots are never trusted.
- Starter has TaskWorkflow, Delegation run and Repo metadata; run's child exactly matches the starter session.
- Authoritative child session is absent, ended or lost; active or unknown state is preserved regardless of run status.

Re-read bindings, run and session after asynchronous Discord reads, immediately before archiving. Read failures are errors, never evidence of absence. A failed thread must not block remaining candidates. Respect the existing orphan dry-run flag. A missing run or deleted webhook is uncertain and is kept for manual diagnosis. This change covers the configured TaskWorkflow forum only, not other team forums or user-owned Session threads.

## Acceptance
CC-DISCORD-TASK-ORPHAN-01 covers archive of the reported missing-session/missing-binding pattern, unchanged run outcome, live/recent/rebound/human/foreign/mismatched protection, read/archive failures, repeated passes, dry-run, and bounded scan rotation.

## Recovery
Discord archive is reversible without message loss. A reviewer can unarchive an incorrectly classified thread and disable automated orphan reconciliation with CONCORDIA_DISCORD_ORPHAN_RECONCILE_DRY_RUN=1. Reverting this change restores the original DB-only sweep.

## Review evidence (2026-09-27)

Production TypeScript check passed. Full test typecheck reports one unchanged fetch-mock error in src/pr/revisor-local-pr-client.test.ts:33; no added-file type errors. Anatomia verify passes rule_conformance, duplication, spec_linkage and convention_drift; coupling_delta warns on anchor 42106b7bab391671 (31 > p95 17), exit 1. Local tests and service restart not executed. Two regression files registered in Augur and cc.acceptance.json. Reported thread archive verified separately at 2026-09-27T03:08:43.860Z; no outcome state changed.
