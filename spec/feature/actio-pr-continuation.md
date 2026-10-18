---
title: Actio PR evidence and continuation
type: feature
id: CC-ACTIO-PR-GOAL-01
---

# Actio PR evidence and continuation

UX-CC-W1/W2/W4/W5, scenarios S1/S2/S3: users must see where a task's
deliverable is, why it is waiting, and which dependency limits progress.
Approved in this conversation on 2026-09-26: 「実装とテストを進める」.

Actio owns task status, dependencies and critical-path calculation. Revisor/GitHub
own PR and review evidence. Cc owns scoped synchronization and continuation
decisions. Store optional `pluginPayload.pull_requests` snapshots preserving all
other metadata. Identity is provider + normalized repository + PR identifier;
number alone never identifies a PR. Missing historical metadata remains empty.

CC-ACTIO-PR-GOAL-01: a snapshot records head, reviewed head, status and observation
time. Test OK for another head is stale; merge is not deployment. Unknown
reflection remains unknown. Updating metadata never completes the business task.
After uncertain PATCH results, reread the same task; never create a replacement.
Serialize plugin updates with existing session assignment writes.

CC-ACTIO-PR-GOAL-02: continuation reads current Actio dependencies and planning
data. Completed, cancelled, blocked, dependency-blocked and cycle-affected tasks
are not executable. Prefer executable critical tasks, then lower slack and stable
task identity. Unavailable or malformed authoritative data stops continuation.
Revalidate before injection and preserve outstanding human questions. Priority,
elapsed time and absent user input never grant merge, deploy or scope authority.

Source and tests belong together in taskflow / autonomous-continuation domains.
Acceptance covers cross-repository identity, metadata preservation, stale heads,
blocked dependencies, cycles, critical priority, remote failure and human waits.
Rollback keeps optional Actio metadata and existing task identities intact.

## CC-RV-TERMINAL-01: terminal notification continuation

2026-10-18 neco requested Discord visibility for Revisor merge completion and
failed reviews in final-answer-only departments, and continuation triggered by
the notification. UX-CC-W2/W4/W5: users must not miss a result or manually wake
an otherwise executable review follow-up.

Revisor owns the verdict; Actio owns task status. Cc recognizes the existing
Revisor completion-notice first-line formats only when source is exactly
`revisor`: automatic merge, failed review, and action-required review. The
`action_required` wording says “マージできません” rather than “失敗”. Unknown
messages, restarts and Open/Test OK are not inferred to be merge completion.
The shared pure policy belongs to autonomous-continuation; Discord presentation
belongs to chat-platforms; HTTP admission/persistence belongs to
session-message-layer. CC-INV-03/04/06/08 apply.

These terminal notifications remain visible in the submitting session's Discord
thread even when inject transcripts are disabled. Other output filtering stays
unchanged. The existing inject is enriched with next-step guidance: reconcile
Actio/PR evidence and fix in-scope findings, or verify merge reflection and
continue authorized remaining work. It emits no second event, runs no new timer,
and does not automatically submit, test, deploy, or mark a task done. Preserve
the original first line and source so existing Discord and taskflow consumers
observe the same event. Repeated enrichment must not duplicate the guidance.

The existing delivery gate still enforces human waits, unanswered questions,
binding and explicit stop conditions. A notification is not new execution
permission. Discord visibility remains independent of permission to deliver
the command. Existing transport replay semantics are unchanged; this change
does not promise durable exactly-once delivery. Manual lifecycle messages sent
only to shared chat are not converted into commands by trusting an author label.

Acceptance: actual merged/failed/action-required messages reach the quiet-department
mirror; Open/Test OK and restart stay suppressed; one HTTP inject emits and
records one enriched event, with unchanged source; guidance cannot bypass a
refusing inject gate. Rollback removes enrichment/visibility exceptions without
changing Revisor outcomes, Actio tasks or saved original notification headings.
