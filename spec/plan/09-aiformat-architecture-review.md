---
type: plan
title: "AI Format and architecture-health review"
service: concordia
domain: analysis-core
status: complete
updated: 2026-07-16
---

# AI Format and architecture-health review

## Formal checks

| Check | Result |
|---|---|
| AI Format category structure | OK: `data`, `feature`, `interface`, `plan`, `setup`, `test` all present |
| Anatomia AI Format spec review | Grade A; 0 findings |
| AI Format personal-data check | 0 violations |
| TypeScript source/test checking | pass |
| dependency-cruiser | pass; 521 modules / 1,955 dependencies; 0 prohibited violations |
| Vitest | pass; 218 files / 1,572 tests |

## Architecture health

The specification-domain score is **54.7/100**. Its strongest components are specification-domain coverage (88.1%), spec linkage (82.3%), and module modularity (75.2%). Its weakest components are cycle health (0) and God Class health (20.2%).

This composite is not a release gate:

- The cycle penalty treats 13 self-recursive functions as cycle groups, while dependency-cruiser finds no prohibited module cycles.
- Static orphan count (3,656) is inflated by tests, callbacks, framework entry points, dynamic dispatch, and 4,574 unresolved calls.
- Persistence’s 61.7 anemia-risk score partly reflects repository/config/auth aggregation and needs taxonomy review.

## Key review findings

1. `DelegationService` is the clearest structural priority: risk 79.8, five product/infrastructure domains, external fan-out 29.
2. Startup and bot composition functions remain too decision-dense (`startBackend` 84; `startDiscordBot` 69; `registerCoreRoutes` 52; `startSlackBot` 48).
3. Domain boundaries are real enough to measure: chat (76.8% cohesion) and observability (68.9%) support separate workers.
4. The README is no longer a reliable capability/status source and contradicts current code.
5. The green test/lint suite is a strong safety net; refactoring should preserve behavior and tighten lifecycle symmetry rather than rewrite broad surfaces.

## Recommended order

1. Refresh the public capability/status matrix from source/spec evidence.
2. Split `DelegationService` behind ports without changing external APIs.
3. Decompose bootstrap/bot lifecycle phases and verify start/stop cleanup.
4. Triage 114 spec-gap candidates, prioritizing production files with high complexity/coupling.
5. Recalibrate architecture scoring to separate product domains, infrastructure, tooling, tests, and self-recursion.

Detailed evidence is in `report/architecture-review-spec-domains.html`, which is a
generated artifact and is not tracked in this public repository. Rebuild it with
`spec/setup/reproducible-build.md`.

## 2026-07-22 structural follow-up

`DelegationService`の外部APIを維持したまま、`contracts`、`plan`、`prompt`、`launcher`、
`executor`、`lease`へ責務を抽出した。queue ownershipはDB CAS + fencing token、起動intentは
transactional outboxに移し、service本体はtemplate解決とcompositionを担う。
