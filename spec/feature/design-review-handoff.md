---
title: Resumable cross-service design review
id: CC-DESIGN-REVIEW-HANDOFF
type: feature
status: draft
service: concordia
domain: tooling
---

# Resumable design review

UX-CC-W2/W5, scenarios UX-CC-S3/S6: an interrupted investigation must retain its
evidence and expose missing work before another reviewer relies on its summary.
This is a supporting `tooling` boundary, not a new core domain or task registry.
Actio owns task status; the supplied maps are historical evidence, not current
runtime state. The source repositories own the facts and must be checked again.

## Invariants

- CC-DESIGN-01: map inputs must be nonempty, belong to the nine named repositories,
  agree with their filename, and provide the fields consumed by the renderer.
  Malformed data fails before any digest is written.
- CC-DESIGN-02: a complete digest requires nine maps and both scouts. Partial
  generation requires `--allow-partial`; every digest lists present/missing maps
  and scouts. Partial output is never labelled a complete review.
- CC-DESIGN-03: Workflow scripts require explicit `args.root`; analysis and
  verification also require `args.wf`. No previous session's scratch directory
  is an implicit input. Invalid/empty selections and missing agent results fail
  instead of being silently removed from the returned evidence.
- CC-DESIGN-04: generated digests are deterministic projections. They cannot
  approve a proposal, authorise tests/publication, or update another service.

## Ownership and recovery

`tools/design-review/digest-input.mjs` validates and reads the supplied evidence.
`tools/design-review/digest-renderer.mjs` is a pure projection to six Markdown
strings. `tools/design-review/make-digests.mjs` owns CLI argument handling and
output writes; the historical script delegates to that entry point. Workflow
scripts only orchestrate the externally provided Workflow `agent` API. They are
not ordinary Node programs and must not run on import.

Recover from invalid input by correcting the named source, or explicitly choose
partial output. Rerun generation into the same directory after a write failure;
multi-file publication is not atomic, so do not consume a failed invocation's
outputs. No database migration, service restart, or deployment is required.

Regression coverage: real supplied map fixtures, completeness, invalid inputs,
deterministic rendering and Workflow argument/selection/result validation. Tests
are added with the implementation; execution still requires user permission.
