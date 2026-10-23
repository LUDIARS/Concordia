---
id: CC-CLOUD-BATCH
title: Codex Cloud batch kicker (parallel fan-out)
status: draft
domain: cloud-execution
---

# Codex Cloud batch kicker

Request (neco, 2026-10-23): run Codex Cloud in parallel for training and
render-farm style work; build the missing kicker. Agreed design: default
concurrency 3, maximum 10, automatic kicks by Cc every few minutes. Follow-up
instruction: test first with the minimum unit 1, so the default concurrency is 1.
Actio `actio:a7e2dbdf-48b8-47c6-a407-3bc9779cec79`.

Values: UX-CC-W2 (retain delegated work), W3 (distinguish result/review/release),
W5 (recover after interruption). Supporting domain `cloud-execution`; not core.

## Model

- Batch: immutable definition = target, Actio task, instruction template with
  `{{name}}` placeholders, 1..100 shards of variables, concurrency 1..10 (default 1),
  compute/LLM reasons, GPU flag and optional work plan. Owned by Cc's batch journal
  (`<cloud-work root>/batches/<scope hash>/<batchId>.batch.json`, insert-if-absent).
- Shard: rendered instruction with deterministic attempt ID `<batchId>-NNN`.
  Submission goes only through the existing `CloudWorkRuntime.submit`, so admission
  (CC-CLOUD-09), standard-hosted/GPU gates, preflight, intent journal and task
  scope are unchanged.
- Phase per shard (pure policy): `queued` (no intent), `unknown` (intent without a
  provider task), `running` (provider task pending or not observed), `remote_ready`
  / `remote_error` (provider finished), `collected` (artifacts verified).
  `remote_ready` is not artifact receipt, review or acceptance.
- Observation: read-only `codex cloud list --env <id> --json --limit 20`, bounded to
  5 pages. Only `id`/`status` (`pending|ready|applied|error`) are kept.

## Invariants

- CC-CLOUD-BATCH-01: in-flight shards (`unknown`, `running`) never exceed the
  batch concurrency. Unobserved or failed observation keeps the slot.
- CC-CLOUD-BATCH-02: a shard maps to one attempt ID; restart, concurrent ticks and
  repeated create cannot submit it twice. An ambiguous submission is never resent.
- CC-CLOUD-BATCH-03: a changed definition under the same batch ID is a conflict.
- CC-CLOUD-BATCH-04: stop prevents new kicks only and never claims remote
  cancellation.
- CC-CLOUD-BATCH-05: unattended kicks re-check the creator session's budget,
  company capacity and pending-question gates; denial holds kicks. Only the closed
  error vocabulary is reported.
- CC-CLOUD-BATCH-06: only Codex Cloud targets are accepted (Claude routines have
  no supported read-only task listing). GPU-required shards remain rejected while
  GPU capability is unverified; training is CPU-only on standard hosting.

## Runtime and API

`/v1/delegation/cloud/batches` (POST create, GET list), `/batches/:id` (GET),
`/batches/:id/stop`, `/batches/:id/tick` (POST, `session_id`). Create and tick
apply the submit gates of the live session. Create durably queues and returns
without provider I/O; manual tick accepts the request and runs through the same
managed background path. Status/list responses use local journal and last observed
state rather than waiting on the provider; list is bounded to 20 batches by default
and 50 at most. The background sweep runs every
`CONCORDIA_CLOUD_KICK_INTERVAL_SEC` (default 180, minimum 60) only when
`CONCORDIA_CLOUD_CONFIG_FILE` is set. Collection stays a separate, explicit
operation per attempt (Git return creates a review PR, so it is not automatic).

Recovery: stop the batch (or unset the cloud configuration). Journals are kept;
never delete intents to retry. Use operator reconciliation for unknown attempts.

## Verification

Focused cloud-work/API tests use injected provider transports. Live Codex Cloud
submission needs a configured environment ID and return destination; not yet
performed. WebUI and MCP controls for batches are not implemented.
