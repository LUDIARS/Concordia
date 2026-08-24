# Delegation Profile Drift and Windows Codex Leak Risk

- Date: 2026-08-24
- Status: fixed in working tree
- Area: delegation seed / persistence / provider routing
- Severity: High — duplicate operator choices and a known Windows logon-session leak path

## Summary

This is a regression. The Delegation Template list contained both the old
model-derived call names and the new capability/effort profiles. Several active
templates still selected the Windows native Codex lane even though Satelles/WSL
was already available to avoid the `CreateProcessWithLogonW` leak.

## Evidence

- The Concordia process started at 2026-08-24 11:32:13 JST.
- Old template rows were rewritten at 2026-08-24 11:32:15 JST by the boot seed.
- `dist/delegation/seed.js` was built on 2026-08-20 while
  `src/delegation/seed.ts` contained the 2026-08-22 profile migration.
- Active duplicate pairs included `claude-fable-5-impl` / `fable-mid`,
  `codex-5-6-sol` / `sol-mid`, and `codex-5-6-luna` / `luna`.
- Inactive stragglers also included suffixed copies (`claude-fable-5-impl-2`,
  `codex-5-5-2`, `codex-5-6-sol-2`) and older `codex-5-5` / `opus4-8` rows.
- `review-duo` instructed its orchestrator to run `codex exec` directly.

## Regression Context

The 2026-08-22 profile migration deactivated old rows instead of deleting them.
A stale build later reseeded the old definitions as active, producing a mixed
list. The same migration converted only Terra to `codex-sdk`; other Codex-backed
Delegations remained on the Windows native CLI path.

## Cause

Cleanup was implemented as archival state (`is_active=0`) owned by the newest
seed, not as a durable data migration and physical deletion. Provider safety was
also encoded per seed entry rather than enforced at the Delegation persistence
and invocation boundaries.

## Fix Requirements

- Physically delete every known legacy call name from global and subsidiary
  Delegation definitions; keep run history with `template_id=NULL`.
- Rename the remaining model-derived implementation profiles to capability and
  effort names.
- Convert every Codex-backed Delegation to `codex-sdk` and normalize legacy
  `codex` input at persistence and invocation boundaries.
- Remove direct `codex exec` instructions from Delegation prompts.
- Keep the migration idempotent and prevent stale seed rows from returning.

## Verification

Regression coverage must assert that legacy rows are absent rather than inactive,
all seeded Codex profiles use `codex-sdk`, deletion preserves run history, and a
legacy `codex` override resolves to the SDK lane. Per session policy, tests were
not run by the implementation session.

## Follow-up

After merge, build the project and restart Concordia through Excubitor with a Cc
testing claim. Confirm that the live active and all-template lists contain no
legacy call names and no `target_provider=codex` definitions.
