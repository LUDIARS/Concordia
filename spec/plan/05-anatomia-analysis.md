---
type: plan
title: "Anatomia code and domain analysis"
service: concordia
domain: analysis-core
status: complete
updated: 2026-07-16
---

# Anatomia analysis

## Run

- Concordia commit: `b8f3ed7e1d11ce746344281884b08c6538506eb4`
- Anatomia commit/version: `2b09de8f79f4c205f6cb797a3135316e764ef56e` / `0.1.0`
- Languages: TypeScript and TSX; 643 files, 5,532 functions, 6,766 resolved calls.
- Parse skips: 0. Unresolved calls: 4,574, all `no-local-candidate`.
- Manual domain input: ten locked files under `spec/data/anatomia-domains/`.

## Specification-domain baseline

The primary report neutralizes Anatomia’s generic `state-machine` and `hot-path-processor` built-ins so the aggregate cannot be dominated by a generic domain. Built-ins remain available in the comparison report.

| Metric | Result | Interpretation |
|---|---:|---|
| Design strength heuristic | 54.7 / 100 | Prioritization signal, not a release gate |
| Specification-domain coverage | 88.1% | 4,752 / 5,392 reviewable functions assigned; 640 unassigned |
| Implementor-weighted cohesion | 58.0% | Mixed; chat and observability are strongest |
| Cycle health component | 0 / 100 | 13 function-cycle groups; mostly self-recursive functions, not module dependency violations |
| Directory modularity | 75.2 / 100 component | Raw modularity 0.628; 691 module misfit candidates |
| Spec linkage component | 82.3 / 100 | 114 file-level spec-gap candidates |
| God Class health component | 20.2 / 100 | Driven by `DelegationService` risk 79.8 |

## Domain signals

| Domain | Implementors | Cohesion | Isolated | Anemia risk |
|---|---:|---:|---:|---:|
| chat-platforms | 990 | 76.8% | 215 | 22.2 |
| observability | 418 | 68.9% | 68 | 21.5 |
| agent-delegation | 493 | 64.9% | 129 | 29.3 |
| session-coordination | 681 | 56.3% | 113 | 26.1 |
| http-interface | 589 | 52.6% | 189 | 37.5 |
| tooling | 740 | 46.7% | 333 | 47.9 |
| governance | 122 | 45.1% | 49 | 45.3 |
| runtime-orchestration | 130 | 44.0% | 41 | 40.1 |
| persistence | 574 | 40.6% | 361 | 61.7 |
| analysis-core | 15 | 26.5% | 1 | 30.0 |

Anemia risk is `45% behavior void + 35% boundary dominance + 20% isolated ratio`. Repository-heavy persistence can score poorly even when separation is intentional, so this is a review prompt rather than proof of an anemic model.

## Hotspots

1. `src/bootstrap/core.ts:336` — `startBackend`, cyclomatic 84, coupling 83.
2. `src/discord/bot.ts:185` — `startDiscordBot`, cyclomatic 69, coupling 71.
3. `src/api/register-core.ts:138` — `registerCoreRoutes`, cyclomatic 52, coupling 52.
4. `src/slack/bot.ts:108` — `startSlackBot`, cyclomatic 48, coupling 49.
5. `src/delegation/service.ts:247` — `DelegationService`, God Class risk 79.8; 10 methods, external fan-out 29, 5 specification domains touched, cyclomatic total 39.

## Limitations

- 3,656 static orphan candidates are inflated by callbacks, tests, framework entry points, dynamic dispatch, and 4,574 unresolved external/dynamic calls.
- “Cycle” is a function call-graph cycle; dependency-cruiser independently reports zero prohibited module dependencies.
- Scores include tests in `tooling`; product-domain conclusions should not treat testing structure as business design.
- Browser/runtime traces and production telemetry were not available.

## Artifacts

- `report/architecture-review-spec-domains.html` — primary exact-baseline review.
- `report/architecture-review.html` — comparison with unmodified built-ins.
- Adjacent `.json` files preserve raw deterministic results.

These artifacts are **generated, not tracked**. This repository is public, so the
analysis output itself stays out of it (only the name and a one-line description
belong here). Rebuild them locally with `spec/setup/reproducible-build.md`.
