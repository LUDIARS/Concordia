---
type: plan
title: "Concordia UX review"
service: concordia
domain: http-interface
status: partial
updated: 2026-07-16
---

# UX review

## Evidence boundary

This review uses `web/src/`, `docs/*.html`, feature specifications, and automated tests. A browser connection was unavailable, so live rendering, responsive behavior, keyboard navigation, screen-reader output, animation, and long-session use were not verified.

## Journey review

| Journey | Finding | Proposal | Impact | Risk | Cost | Validation |
|---|---|---|---|---|---|---|
| First setup | Configuration spans core, provider hooks, chat platforms, workers, auth, and lifecycle control. | Add a role-based setup wizard/checklist with capability detection and one verified “first useful session” milestone. | Faster activation, fewer silent misconfigurations | Wizard can drift from config schema | M | Time-to-first-session; setup abandonment; support contacts |
| Fleet overview | Sessions, conflicts, costs, chat, tasks, and health compete for attention. | Default to exceptions: conflict, lost, blocked, stale, budget breach; progressively reveal healthy detail. | Lower scanning load | Hidden detail may slow expert diagnosis | M | Time to identify highest-risk session; false escalation rate |
| Conflict handling | The no-lock model preserves autonomy but advisory warnings can look optional or ambiguous. | Show conflict scope, files/branch, confidence, recommended isolation action, and “why this is advisory.” | Better worktree adoption and trust | Overwarning causes habituation | S-M | Warning-to-isolation conversion; dismiss reasons; overlap incidents |
| Lost-session recovery | Recovery has many states and provider-specific evidence. | Use a state timeline with last evidence, recovery source, next safe action, and undo/abandon paths. | Faster, safer handoff | State model complexity | M | Recovery completion time; wrong-resume rate; abandoned tasks |
| Delegation | Templates, provider choice, effort, worktree, and run status create decision density. | Separate “what outcome?” from advanced execution controls; show preflight and reversible cancel. | Lower delegation error and delay | Defaults may hide cost/authority implications | M | Launch completion; cancellation; failed-start rate; regret survey |
| Testing/restart claims | Claims prevent collisions, but stale claims can block or confuse operators. | Display owner, age, note, service scope, and explicit release/escalation affordance. | Safer service operations | Premature release | S | Stale-claim age; collision count; manual escalation count |
| Error recovery | Worker/core separation introduces partial-failure states. | Use distinct core/chat/cost health badges with last successful reconcile and degraded-capability copy. | Clearer blast radius | Status overload | S-M | Correct diagnosis in task test; duplicate restart attempts |

## Accessibility and fatigue

- Do not rely on color alone for active/lost/blocked/degraded states.
- Ensure all destructive controls have semantic names, focus order, confirmation context, and post-action status.
- Add density controls or saved views for long-running operators.
- Batch repetitive low-severity notifications and expose a notification rationale.
- Preserve timestamps with timezone and relative/absolute toggle.

## Static contradictions

- Existing generated review material already records a partial/diverged Discord UI specification (`docs/review.html:65`).
- Existing generated test documentation reports older test counts (`docs/review.html:87`), demonstrating that static docs can lag the implementation.

## Required follow-up

Run approved visual QA against the Web monitor and generated final report at desktop/mobile widths, including keyboard-only and screen-reader smoke checks. Until then this stage remains `partial`.
