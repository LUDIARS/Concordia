---
type: plan
title: "Specification gaps and contradiction register"
service: concordia
domain: governance
status: partial
updated: 2026-07-16
---

# Specification gaps and contradictions

| Priority | Finding | Evidence | Proposed decision |
|---|---|---|---|
| P0 | README maturity/provider claims are stale. | `README.md:70` says Gemini/Codex are stubs; `README.md:203` says v0.1 scaffold, while provider, Codex, delegation, worker, and MCP code/tests exist. | Replace the historical status section with a generated capability matrix linked to current specs/tests. |
| P0 | `DelegationService` concentrates five specification domains. | `src/delegation/service.ts:247`; God Class risk 79.8, fan-out 29. | Split orchestration, launch policy, provider invocation, persistence, and notification ports by responsibility; preserve transaction boundaries. |
| P1 | Bootstrap and bot entry points remain highly complex. | `startBackend` 84, `startDiscordBot` 69, `registerCoreRoutes` 52, `startSlackBot` 48. | Extract lifecycle phases and injected adapters; require start/stop symmetry tests. |
| P1 | Static call graph has 13 cycle groups. | Anatomia code review. Most groups are single-function recursion (`collectRecent`, `walk`, `parseResp`, etc.). | Classify intentional recursion and exclude self-cycles from the architecture score; investigate only multi-node cycles. |
| P1 | 114 source files lack strong static spec linkage. | `report/architecture-review-spec-domains.html.json`. | Triage production files first; add `related` or explicit rule IDs only when a real contract exists. |
| P1 | Persistence has high anemia-risk heuristic (61.7). | 574 implementors, 40.6% cohesion, 62.9% isolated. | Review taxonomy: separate durable repositories from auth/config/secrets before interpreting this as domain anemia. |
| P1 | UX evidence is incomplete. | No browser connection; no live runtime or responsive inspection. | Run the report and Web monitor through an approved visual QA session; capture onboarding and recovery flows. |
| P2 | Runtime security outside loopback is unresolved in this run. | README’s local/no-auth statement is historical; current auth/config code was not penetration tested. | Publish a current trust-boundary matrix and automated non-loopback/admin authorization tests as the normative evidence. |
| P2 | Tooling is modeled as a domain. | 740 implementors, 47.9 anemia risk. | Keep it for coverage accounting but exclude it from product-domain health summaries. |

## Positive evidence

2026-07-22 follow-up: the structural P2 pass extracted AdminState domain stores,
bootstrap phases/resource ownership, HTTP route groups/purpose-specific deps, and
Discord/Slack lifecycle-routing-projection-interaction modules. Recursive taxonomy
membership now classifies nested adapter/API/bootstrap modules; the former command
type cycle exclusions were removed from dependency-cruiser.

- All 1,572 tests pass.
- TypeScript and dependency-cruiser pass with no prohibited dependency violations.
- AI Format structure is Grade A with all six categories present and no personal-data violations.
- No files were skipped by Anatomia.

## Open decisions

- Whether the ten-domain taxonomy should distinguish product domains from infrastructure and tooling domains.
- Whether architecture scoring should exclude tests, generated adapters, self-recursion, and repository CRUD from product-health aggregation.
- Whether `analysis-core` is an intentional bounded context or a temporary placement for small analysis utilities.
