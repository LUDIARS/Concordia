---
type: plan
title: "Specification, domain, and code map"
service: concordia
domain: analysis-core
status: partial
updated: 2026-07-16
---

# Specification–domain–code map

| Rule | Domain | Implementation evidence | Test/spec evidence | Classification |
|---|---|---|---|---|
| C-01 session registration/discovery | session-coordination, http-interface, persistence | `src/api/sessions/`, `src/db/sessions-repo.ts` | `spec/interface/service-schema.md`, API tests | implemented |
| C-02 progress/event sharing | session-coordination, http-interface | `src/api/sessions/events.ts`, `src/events.ts` | session/event tests | implemented |
| C-03 lost detection/recovery | session-coordination, runtime-orchestration | `src/sweeper.ts`, `src/control/`, `src/providers/` | control/provider tests | implemented |
| C-04 advisory conflict coordination | session-coordination, agent-delegation | `src/testing/branch-watch.ts`, `src/work/`, `src/db/testing-claims-repo.ts` | testing/work API tests | implemented |
| C-05 chat is an adapter | chat-platforms, runtime-orchestration | `src/chat-worker.ts`, `src/platform/`, `src/discord/`, `src/slack/` | `spec/plan/process-isolation-v2.md` | partial: high coupling remains |
| C-06 cost isolation | observability, runtime-orchestration | `src/cost-worker.ts`, `src/bootstrap/cost.ts` | cost/metrics tests | implemented; runtime SLO unverified |
| C-07 delegation is traceable | agent-delegation, persistence | `src/delegation/service.ts:247`, `src/db/delegation-repo.ts` | `spec/feature/delegation.md`, delegation tests | implemented; concentration risk |
| C-08 testing claim lifecycle | agent-delegation, governance | `src/db/testing-claims-repo.ts:40-67`, `src/testing/` | test-claim tests/spec | implemented |
| C-09 private data boundary | persistence, governance | auth/config/repository boundaries | AI Format personal-data check: 0 violations | partial: runtime/privacy audit not performed |
| C-10 stable interfaces through isolation | http-interface, runtime-orchestration | `src/app.ts:23`, route registrars, workers | API tests, process isolation specs | implemented at test level |

## Strong mappings

- Session coordination has a large, distinct implementation set (681 implementors) and 56.3% cohesion.
- Chat and observability have the strongest measured cohesion (76.8% and 68.9%), supporting the 3-axis separation direction.
- Dependency-cruiser passes with no prohibited module dependencies, so the declared import boundaries are mechanically enforced.

## Weak or incomplete mappings

- Anatomia reports 640 functions outside the ten specification domains.
- 114 files are file-level spec-gap candidates, including `src/api/daily.ts`, `src/api/harness-rules.ts`, `src/api/prs.ts`, `src/api/register-web.ts`, `src/api/reports.ts`, `src/api/rules.ts`, `src/api/taskflow.ts`, and several cost/control modules.
- `DelegationService` touches agent-delegation, chat-platforms, observability, persistence, and session-coordination, which weakens the intended boundary even though import lint passes.
- The top-level README still describes older provider and maturity states, creating a source-to-code contradiction.

## Classification caution

Anatomia candidates are not automatically defects. Dynamic framework entry points, callbacks, route registration, and tests can look orphaned or weakly linked under static analysis. Human triage should start with high-complexity, cross-domain production code rather than bulk-deleting candidates.
