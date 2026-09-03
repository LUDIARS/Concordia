# Revisor #1293 schema contract regression

- Date: 2026-09-04
- Status: fixed in working tree
- Area: database migrations / taskflow tests
- Severity: registered test and lint gates blocked

## Summary

Migration 83 added the nullable `delegation_runs.category` snapshot, but two derived contracts were not updated. This is a regression because the registered migration-ledger test and TypeScript test compilation no longer passed.

## Evidence

- `src/db/migration-ledger.test.ts` expected the generated schema fingerprint to equal `124e7155...`, but migration 83 produced `90f4d5ad...`.
- `src/taskflow/overview.test.ts:148` constructed a `DelegationRunRow` without its required `category` field (TS2741).

## Regression Context

The frozen migration entry for version 83 was present and its checksum test passed. The failure was limited to the aggregate schema fingerprint and a stale typed fixture.

## Cause

The schema fingerprint and taskflow fixture were not updated when `DelegationRunRow.category` and migration 83 were added.

## Fix Requirements

- Pin the schema fingerprint produced after all 83 migrations.
- Represent the legacy/unknown category in the taskflow fixture as `null`.
- Do not relax the migration ledger or the `DelegationRunRow` type.

## Verification

Revisor must rerun the registered `test` and `lint` checks. No repository code was run during this autofix, per the task constraint.

## Follow-up

None.
