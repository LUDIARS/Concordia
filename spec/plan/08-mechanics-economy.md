---
type: plan
title: "Mechanics and economy applicability / operational loop analysis"
service: concordia
domain: observability
status: not-applicable
updated: 2026-07-16
---

# Mechanics and economy analysis

Game mechanics and internal game economy are `not-applicable`. The following is an operational value-flow model, not a game economy score.

## Operational loop

`session hook → durable state → peer/operator visibility → coordination decision → isolated or delegated work → report/handoff → next session`

## Sources, stores, converters, sinks, and gates

| Kind | Concordia element | Health note |
|---|---|---|
| Source | session registrations, events, heartbeats, chat input, usage samples | High input variety increases validation and routing complexity. |
| Store | SQLite repositories, pending tasks, reports, durable outbox | Durability supports recovery; repository proliferation contributes to persistence isolation. |
| Converter | hooks → session state; events → reports; reactions → actions; templates → delegation runs | `DelegationService` is the largest concentration point. |
| Gate | auth, provider capability, testing claim, worker lease, budget/rule policy | Gates need explicit refusal and recovery feedback. |
| Sink | retention GC, ended sessions, delivered tasks, completed/failed runs, released claims | Unreleased claims and stale sessions require observable cleanup. |
| Feedback | Web/Discord/Slack status, conflict warnings, stats, reports | Rich feedback can become alert fatigue without prioritization. |

## Qualitative health

- **Loop cleanliness:** the core coordination loop is legible, and tests cover it broadly.
- **Dominant risk:** coordination metadata can become another attention burden if every event is surfaced equally.
- **Starvation risk:** missing heartbeats, disconnected workers, or provider-specific hook gaps can starve the shared state of fresh evidence.
- **Inflation risk:** event/report volume and notifications can grow faster than operator attention; retention and aggregation policies are essential.
- **Recovery:** durable state, lost detection, resume/handoff, worker reconciliation, and testing-claim release are strong recovery primitives.

No numerical economy score is assigned because there are no game resources or calibrated production telemetry in scope.
