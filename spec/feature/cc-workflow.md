---
title: "Cc workflow injection"
status: implemented
service: concordia
domain: session-coordination
updated: 2026-07-06
---

# Cc workflow injection

Concordia injects a startup workflow packet into each registered agent session.
The packet is returned as `context_packet.cc_workflow` from `POST /v1/sessions`
and `GET /v1/sessions/:id/context`, then printed by `tools/concordia-hook.mjs`
as `[concordia/cc-workflow]`.

The workflow requires agents to:

- break work into todos and submit `task_update` through the Concordia API;
- create or switch to a task branch before editing;
- push the branch and open a PR after implementation;
- append user interruptions after the current queue unless explicitly marked as priority;
- monitor PR CI, request final tests when CI is green, merge only after tests pass, and fix the PR when CI is red.

PR CI follow-up is also backed by the existing PR reconciler. When GitHub status
changes to `success` or `failure` for a session-authored PR, Concordia enqueues
a `pr-ci-followup` pending task for the author session. The hook prints that task
on the next prompt/heartbeat/session-end pull.
