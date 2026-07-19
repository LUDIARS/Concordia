---
type: interface
title: "Omnipotens runtime boundary assessment"
service: concordia
domain: runtime-orchestration
status: partial
updated: 2026-07-16
---

# Runtime boundaries

## Process roles

- **Core:** owns session truth, durable coordination, APIs, recovery, and governance decisions.
- **Chat worker:** adapts Discord/Slack input and output; may degrade without redefining core state.
- **Cost worker:** samples and aggregates usage/cost; may delay reporting without blocking coordination.
- **External lifecycle controller:** owns service start, stop, restart, health, and logs. Endpoints and ports must be resolved from the approved service catalog/ProcessMap, never copied from README examples.

## Allowed dependency direction

1. Presentation/adapters depend on typed core contracts or injected ports.
2. Core must not import chat SDK behavior or optional reporting loops.
3. Persistence implements context-owned repository contracts but does not own business meaning.
4. Workers communicate through versioned HTTP/WS/durable-outbox contracts and explicit leases.

## Evidence and residual risk

- dependency-cruiser reports zero prohibited dependency violations.
- Chat and observability show strong internal cohesion (76.8% and 68.9%).
- Runtime orchestration cohesion is 44.0%; `startBackend` has cyclomatic 84 and coupling 83.
- `DelegationService` crosses five specification domains, indicating semantic coupling not fully captured by import rules.

## Unverified runtime properties

- Core availability during real worker crash/restart.
- Lease/outbox recovery under process termination and SQLite contention.
- Non-loopback authorization and remote-control trust boundaries.
- End-to-end latency and Discord/Slack acknowledgement behavior.

No service process was started for this review.
