---
task: limit-history-90-days
project: Cc
kind: feature
created: 2026-10-16
memory_links: []
---

# Retain observed limit history for Memoria's three-month view

Human instruction: neco requested 3-month / 1-month / 1-week / 1-day / 1-hour windows
for Memoria's weekly remaining-limit graph. Existing Cc pruning at 60 days cannot supply a
90-day history; extend only limit-observation retention to 90 days.

Value / invariant: `CC-COST-LIMIT-HISTORY-90D` in `spec/feature/cost-observability.md`.
Supporting domain: `observability`. Cc remains the sole history owner. Existing sampler,
schema, provider observations and pruning mechanism are reused; token-sample retention stays 60 days.
Previously deleted samples cannot be restored and must not be fabricated.

Acceptance: `cost_limit_samples` pruning uses 90 days; `cost_usage_samples` pruning still uses 60 days.
Recovery: revert this commit (returns retention to 60 days at the next limit-sampler run).
Validation: static change inspection; no service restart or test execution before Revisor review.
