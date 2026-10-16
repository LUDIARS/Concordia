---
title: LUDIARS 9-tool design review — Concordia
type: plan
status: proposed
service: concordia
domain: project-code-registry
updated: 2026-10-17
tags: [design-review, cross-service]
---

# Concordia: reliable identity and coordination

## Shared ownership model

The nine-tool review keeps the services independently deployable. Similar names
are not enough to merge state: Actio owns task content/status, Pf owns versioned
specification/design, An owns implementation analysis, Augur owns test planning
and execution evidence, Rv owns review/merge/publication, Cc owns session/run
coordination, Cf owns game-flow adoption and play feedback, Br owns derived
summaries, and Genius owns judgment cards and their privacy/lifecycle.

Priorities: (1) reliable repository identity and explicit integration failures;
(2) evidence-preserving batched reads instead of repeated CLI cold starts;
(3) consistent discovery and preparation contracts; (4) notifications with
durable identity. Do not merge independent state machines into a global database
or replace explicit disconnected states with guessed URLs.

## Checked boundary and findings

Reviewed local main: `6e6ec91b`. Evidence: src/implementation-tools/service.ts,
src/api/implementation-tools.ts, src/taskflow/repository-identity.ts,
src/projects/project-resolver.ts, src/db/sessions-repo.ts.

| Finding | Verification / counterargument | Decision |
|---|---|---|
| Explicit bind uses a resolver that supports approximate leaf-name matching. | Appropriate for display inference; not a reliable identity for a write. Canonical Git common-dir is already available. | Match canonical registered path exactly for bind; leave display inference alone. |
| Task/repo patch, metadata and event are separate writes. | A DB error after the first write can leave partial state. Checking Actio availability does not address it. | One SessionsRepo transaction with stale-snapshot rejection. |
| Every bind error becomes the same 409. | Public errors must be redacted, but this does not require losing the stage and a controlled reason. | Structured fixed-vocabulary failure response. |
| Notification can throw after successful binding. | Response loss is still unknown; a synchronous notification exception is distinct from persistence failure. | Keep success after commit and indicate deferred notification. |
| Session/run/task ledgers overlap in terminology. | Delegation execution, task status and source evidence have different owners. | Keep separate; carry stable Actio/run references rather than duplicating bodies. |

User-reported incident: AC bind sometimes reports inner 409 / outer Lictor 500
with a Castra repository still visible. The triggering exception is not yet
reproduced. The source defects above are confirmed; they are not asserted as the
incident's uniquely proven root cause.

## Implementation and acceptance

Supporting domains: project-code-registry (validation/orchestration),
session-lifecycle (atomic session persistence). UX-CC-W1/W5; CC-INV-01/04;
CC-BIND-01–04 in spec/feature/implementation-tools.md.

Implementation: exact canonical lookup; optional origin absence distinguished
from Git failures; controlled failure reasons; transactional session/metadata/
event update; stale snapshot rejection; post-commit notification separation.
Tests cover stale declarations, rollback on evidence failure, no heuristic bind,
safe response content, and notification failure after commit. Implementations
and tests are registered in cc.acceptance.json.

Validation: typecheck of test project was attempted; no diagnostics named the
changed binding/persistence files, but the command failed on existing diagnostics
in other modules. This is not a passing full typecheck. Session tests have not
been executed directly because no such execution permission was given. Revisor
review and exact merge/reflection remain pending at submission time.

Recovery: correct the named prerequisite, reread binding, retry the same intended
checkout. Transaction failures preserve the old binding. No DB migration. Live
deployment requires the normal approved build/Excubitor lifecycle; code merge
alone does not prove that the running service changed.

## Cross-service proposals and remaining work

- Cc/Actio: preserve task references and one state owner; do not make task-label
  success stand in for repository bind success.
- Cc/Cf: agree explicitly on spawn/lookup/build/identity contracts and request
  correlation before enabling those disconnected adapters. Do not invent paths.
- Cc/Rv/Br: add owner-provided bounded batch projections with repository, exact
  commit and observation time before replacing serial CLI consumers.
- Cc/An/Augur: keep requirement evidence, test registry and code-analysis views
  distinct; share identifiers and explicit provenance, not a mutable common ledger.

Each of the other eight tools receives its own repository-local review/proposal.
Historical Workflow reader/scout executions are not marked complete by this
manual source review. Large migrations, changed polling/timeouts and auth
changes remain proposals requiring their own evidence and acceptance criteria.
