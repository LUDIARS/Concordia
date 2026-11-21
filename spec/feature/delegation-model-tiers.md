---
title: Delegation model tiers and quota substitution
type: feature
id: CC-DELEGATION-MODEL-TIERS
status: draft
domain:
  - delegation-launch
  - observability
---

# Model allocation at the shared launch boundary

> 所属ドメイン: [`delegation-launch`](../domains/delegation-launch.domain.json) · [`observability`](../domains/observability.domain.json)

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
- DMT-06: A provider may explicitly report only a weekly window. The observability
  adapter preserves confirmed absent windows separately from missing or malformed
  observations. Launch checks every applicable window and requires at least one.
  An absent window is omitted, never fabricated as 0% used; unknown or expired
  applicable windows still prevent substitution. Usage I/O owns absence evidence;
  delegation-launch owns eligibility. This preserves UX-CC-W2 when Claude is
  exhausted and Codex reports a valid weekly-only allocation.
- DMT-07: Opus on the Antigravity CLI (agy) Claude quota is a separate Delegation
  template (neco 2026-11-21: 「Geminiの起動とわかるようにDelegation Templateは別で用意して
  絵文字も変えよう」), never a silent provider swap inside the Opus template. Seed
  provider `agy`, model `claude-opus-5-5-<effort>` (agy encodes effort in the model ID;
  `agy models` lists low / medium / high), call_name `opus-gemini`, title
  「Opus (Gemini 枠)」, emoji 🔹 (neco 2026-11-22: changed from 🔷 so it is distinct
  from Gemini Argon's 🔷), sorted right after Opus. The identity lives in one
  constant (`src/delegation/opus-agy-identity.ts`). A rerouted run records the agy
  template's call_name / template_id, so Discord and Web launch displays show its
  emoji and title. Files: `opus-agy-identity.ts`, `opus-agy-reroute.ts`, `seed.ts`,
  `service.ts`.
- DMT-08: An Opus launch request (call_name `opus` via invoke, spawning, no explicit
  provider / model / model_tier) is rerouted to the DMT-07 template only when the agy
  Claude quota (`Claude and GPT models` rows of `agy -p /usage`, tightest window) is
  known and above 0% remaining (threshold 0). Effort xhigh / max (and any effort with no
  agy model, e.g. auto), fetch failure, unreadable output, an already-reset window, 0%
  remaining, or a disabled / missing agy template keep the original Opus template.
  Usage I/O (`opus-agy-usage.ts`, shared 4-minute cache of `agy-usage-fetch.ts`) is
  separate from the pure policy (`opus-agy-route.ts`). The raw template spawn path
  (`/v1/admin/spawn` with `inject_prompt=false`) is not rerouted.

Recovery: revert the change and use the authorized normal build/deployment path.
Do not delete run/task history or replay uncertain launches. Tests cover both
directions, both exhausted, unknown, reset windows, model-specific limits and
all four levels. Real takeover/deployment evidence is recorded separately.
