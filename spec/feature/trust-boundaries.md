---
type: feature
title: "Concordia principals and trust boundaries"
service: concordia
domain: governance
status: implemented
updated: 2026-07-22
related:
  - ./develop-confirm-flow.md
  - ../setup/spawn.md
  - ../interface/service-schema.md
---

# Concordia principals and trust boundaries

Every HTTP request has an explicit principal. An absent or invalid credential
is the `anonymous` principal with read-only capability; it is never represented
by an empty admin token. Protected mutation routes fail closed when
`CONCORDIA_ADMIN_TOKEN` is absent. The legacy admin token authenticates the
fixed `admin` principal; caller-controlled identity headers are ignored. Named
principals are configured by `CONCORDIA_PRINCIPAL_TOKENS` as a JSON array of
`{ "id", "role", "token" }`. IDs and tokens must be unique, tokens must be at
least 16 characters, and a malformed registry fails closed as empty.

Capabilities are `read`, `chat:write`, `session:control`, `process:control`,
`release:confirm`, and `admin:write`. Route composition declares the required
capability. Chat keeps a caller-selected display label, but durable metadata
always records `authenticated_principal_id` and role.

Cc-spawned sessions use `CONCORDIA_SPAWN_ID` as a one-time enrollment value.
An unknown or consumed value is rejected instead of degrading to an unowned
session. A WebSocket that claims `?session=<id>` must also provide the matching
`?enrollment=<CONCORDIA_SPAWN_ID>`; observer sockets may omit both.

Process ownership is `(instance_id, generation)`, not PID. Each start receives
a random instance id and a monotonically increasing generation. External stop
requests must echo both values and stale ownership fails with
`ownership_mismatch`. Lost-session reaping additionally requires the one-time
spawn id and a matching `start_iso` process generation before PID kill is
eligible.
