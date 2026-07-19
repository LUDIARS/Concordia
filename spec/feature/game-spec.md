---
type: feature
title: "Omnipotens gameplay applicability and Concordia system specification"
service: concordia
domain: session-coordination
status: not-applicable
updated: 2026-07-16
---

# Gameplay applicability and system specification

## Applicability decision

**[source] Concordia is multi-agent coordination software, not a game** (`README.md:3-6`). Therefore rules about players, win/loss, authored challenges, game loops, progression, combat, and game economy are `not-applicable`. This file exists to satisfy the Omnipotens artifact contract without relabeling software behavior as gameplay.

## System rules used as the review baseline

| ID | Rule | Provenance |
|---|---|---|
| C-01 | A session can register its repository, host, working directory, branch, and provider and discover peers. | source: `README.md:55-65`; spec: `spec/interface/service-schema.md` |
| C-02 | Progress and significant events become shared session state. | source: `README.md:55-65`; code: `src/api/sessions/` |
| C-03 | Stale/lost sessions can be detected, recovered, resumed, or handed off. | source: `README.md:55-65`; code: `src/sweeper.ts`, `src/control/` |
| C-04 | Concurrent work is coordinated without imposing a global lock. | source: `README.md:6`, `README.md:67-73`; code: `src/testing/`, `src/work/` |
| C-05 | Chat platforms are interaction surfaces and must not define core coordination semantics. | source: `spec/plan/refactor-3axis-architecture.md`; code: `src/chat-worker.ts`, `src/platform/` |
| C-06 | Cost collection is observable but must not make the coordination core unavailable. | source: `spec/plan/refactor-3axis-architecture.md`; code: `src/cost-worker.ts` |
| C-07 | Delegation is explicit, traceable, provider-aware, and recoverable. | spec: `spec/feature/delegation.md`; code: `src/delegation/service.ts` |
| C-08 | Service start/restart testing is coordinated through testing claims and approved lifecycle control. | spec/code: `src/db/testing-claims-repo.ts`, `src/testing/` |
| C-09 | Local secrets and private session content must not be copied into review artifacts. | source: `README.md:71-72`; AI Format privacy check |
| C-10 | Public interfaces and wire contracts remain stable through internal process isolation. | source: `spec/plan/refactor-3axis-architecture.md` |

## Invariants

- One session ID denotes one durable session identity even when its process reconnects.
- Optional chat/cost failures must not redefine or corrupt core session state.
- A worktree recommendation is advisory; it does not silently switch another session’s branch.
- Destructive control and remote execution paths require explicit authority and auditable provenance.
- No generated review substitutes unavailable runtime evidence with mocks or fabricated results.

## Unresolved questions

- **[question]** Which runtime SLOs are release gates for core, chat worker, and cost worker?
- **[question]** What is the supported security model when binding beyond loopback?
- **[question]** Which README capabilities are current, deprecated, or historical after the 3-axis refactor?
