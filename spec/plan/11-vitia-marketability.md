---
type: plan
title: "Vitia marketability analysis"
service: concordia
domain: governance
status: complete
updated: 2026-07-16
---

# Vitia marketability analysis

## 1. Truth ledger

### Verified

- Concordia coordinates concurrent AI coding-agent sessions and makes work, conflicts, recovery, reports, costs, and delegation visible.
- It is MIT-licensed local software with a passing suite of 1,572 tests and enforced TypeScript/module boundaries.
- The pinned code has Web, MCP, Discord, Slack, delegation, testing-claim, cost, and worker-isolation surfaces.

### Assumed

- Primary audience: technical teams already running multiple coding-agent sessions locally.
- Primary acquisition objective: get a qualified team to install, connect two sessions, and observe one coordination benefit.
- The strongest pain is wasted work and blocked goals, not entertainment or status.

### Unknown

- Price/support model, public distribution channel, active-user count, retention, setup conversion, measured time savings, competitive win rate, and willingness to pay.

## 2. Diagnosis

- Objective: qualified activation and trust.
- Bottleneck: a broad feature surface and stale top-level narrative make it hard to understand the first concrete outcome.
- Audience context: technically capable operators with high coordination cost, high skepticism of automation claims, and real authority/security concerns.

## 3. Domain selection

Deterministic Vitia input: `spec/data/vitia-input.json`; Vitia commit `382de6a345279d2967e03e19918a0931088e91e1`.

| Domain | Score | Coverage | Decision |
|---|---:|---:|---|
| Avaritia | 0.651 | 0.85 | Primary: measurable avoided coordination loss and local ownership |
| Ira | 0.647 | 0.80 | Secondary: acknowledge blocked work and restore agency |
| Acedia | 0.630 | 1.00 | Excluded from the same treatment; use in onboarding experiments |
| Gula | 0.620 | 1.00 | Excluded; retention should follow delivered value, not engagement |
| Luxuria | 0.503 | 0.45 | Insufficient signal coverage |
| Superbia | 0.436 | 1.00 | Below primary threshold |
| Invidia | 0.381 | 0.30 | Low evidence and comparison is not the core job |

These scores route strategy work; they do not diagnose people or prove causality.

## 4. Strategy card

- Audience hypothesis: teams using several coding agents lose time to duplicate edits, stale sessions, and fragmented handoffs.
- Primary mechanism: truthful value framing — show avoided rework and faster recovery, with disclosed measurement assumptions.
- Secondary mechanism: blocked-goal recovery — acknowledge coordination failure and restore control without blaming tools or teammates.
- Verified feature → outcome → mechanism: shared session/conflict/recovery state → fewer invisible collisions and clearer handoffs → measurable coordination-value hypothesis.
- Proposition: “Keep parallel coding agents visible, recoverable, and out of each other’s way—without locking their work.”
- Proof: passing test/lint suite; live conflict/recovery demo; auditable local data flow; architecture and trust-boundary documentation.
- Message angle: show one duplicate-work scenario before/after, then explain exactly what Concordia observes and what remains advisory.
- CTA: “Connect two local sessions and verify the shared activity view.”
- Channel: technical README, short reproducible demo, architecture note, and team-tooling communities.
- Boundary conditions: do not promise a percentage of time saved until measured; do not imply remote security guarantees beyond documented configuration.

## 5. Experiment

- Control: current README opening and setup path.
- Treatment: outcome-first landing/readme with a two-session reproducible demo, explicit local-data boundary, and one activation CTA.
- Population: teams already using at least two coding-agent sessions; exclude single-session evaluators from the primary analysis.
- Primary metric: qualified activation — two sessions registered and one shared-state/conflict/recovery view completed within the first evaluation session.
- Guardrails: setup abandonment, security/trust concern rate, accidental control action, uninstall/rollback, and support contacts.
- Horizon: continue until each arm has enough qualified evaluators for a predeclared confidence/effect threshold; do not stop on early directional lift.
- Disconfirming result: higher starts but no increase in two-session activation, or any material increase in trust concerns or accidental control actions.

## 6. Ethics check

- No vulnerable-targeting, fabricated scarcity, hidden defaults, or compulsive engagement mechanism is proposed.
- Quantified ROI remains a hypothesis until instrumented and validated.
- The CTA is voluntary and reversible; local-data/trust boundaries must be disclosed before control features.
- “Ira” is used to frame a blocked workflow and restored agency, not to inflame grievance or blame a group.
