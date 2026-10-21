---
title: Delegation model tiers and quota substitution
type: feature
id: CC-DELEGATION-MODEL-TIERS
status: draft
---

# Model allocation at the shared launch boundary

User instruction: neco 2026-10-21; all Delegation entry points, including taskflow.
Value: UX-CC-W2 / AD-S2 and AD-S5 (spec/ux/agent-delegation.md): preserve the
same job and its progress when a provider's usage allocation is exhausted.
Domain: delegation-launch, the launch responsibility supporting agent-delegation.

The request names a level (`ultra`, `high`, `medium`, `low`). Proposed mapping:
ultra = Opus/Astra; high = Sonnet/Sol; medium = Haiku/Luna with high reasoning;
low = Haiku/Luna with low reasoning. Existing explicit models retain their model
unless their applicable quota is confirmed exhausted; Opus↔Astra and Sonnet↔Sol
are symmetric substitutions. Local and other unsupported providers retain their route.

State owners: provider adapters own usage observations, DelegationRepo owns
templates/run identity, service launch owns resolved provider/model/effort.
Selection is a pure policy; usage I/O is a separate adapter. Queue release checks
usage again, rather than trusting the observation at enqueue time.

- DMT-01: Never launch a candidate whose applicable current usage window is >=100%.
  Missing, invalid or expired observations are unknown, never proof of free quota.
- DMT-02: Tier allocation and replacement require a known available candidate;
  no candidate returns an explicit error before spawn. No lower-tier downgrade.
- DMT-03: Legacy requests with unknown usage preserve their requested model;
  known exhaustion cannot be ignored, including when the alternate is unknown.
- DMT-04: Candidate choice maximizes remaining quota within the requested level;
  ties preserve the original provider. Every substitution is logged and the run
  records the effective provider/model. Existing scope and launch gates remain.
- DMT-05: Existing running jobs are not automatically duplicated by this selector.
  Human-authorized Opus takeover must separately verify original task, working
  directory, live ownership, review status and saved progress before replacement.

Recovery: revert the change and use the authorized normal build/deployment path.
Do not delete run/task history or replay uncertain launches. Tests cover both
directions, both exhausted, unknown, reset windows, model-specific limits and
all four levels. Real takeover/deployment evidence is recorded separately.
