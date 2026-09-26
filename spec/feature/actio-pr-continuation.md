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
