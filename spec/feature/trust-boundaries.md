---
type: feature
title: "Concordia platform identity and trust boundaries"
service: concordia
domain: governance
status: implemented
updated: 2026-07-24
related:
  - ./develop-confirm-flow.md
  - ../setup/spawn.md
  - ../interface/service-schema.md
---

# Concordia platform identity and trust boundaries

Concordia HTTP is an internal loopback API. It does not use a shared admin
service token: such a token identifies a process path, not the human who
triggered a launch, and requiring it broke Web UI, worker, and MCP delegation.
Non-loopback bind is rejected. The Web UI is exposed only behind AccessControl,
where every admitted user is an administrator.

Discord and Slack launch authorization happens at their authenticated platform
adapters. Gateway / Socket Mode supplies the triggering platform user ID.
Spawn and delegation require that user ID to hold the `session_spawn`
capability in the staff roster (`staff_members`, see
[staff-roster.md](staff-roster.md)) — i.e. a role of 管理職 or above. A missing
ID, an unregistered user, a lower role, or an uninjected permission checker
denies the launch (fail-closed). The reaction workflow switch does not bypass
or disable this launch check.

Internal callers such as the delegation MCP server and chat worker use the
loopback API directly. Caller-provided `triggered_by` metadata is correlation
data, not authentication, and must never be used to bypass platform ingress.

Cc-spawned sessions use `CONCORDIA_SPAWN_ID` as a one-time enrollment value.
An unknown or consumed value is rejected instead of degrading to an unowned
session. A WebSocket that claims `?session=<id>` must also provide the matching
`?enrollment=<CONCORDIA_SPAWN_ID>`; observer sockets may omit both.

The enrollment requirement applies to sessions that actually carry that secret.
Only Cc-spawned sessions are issued one, so a session registered outside a Cc
spawn (a manually started Lictor session) has nothing to present. Demanding
enrollment there is unsatisfiable: the socket is closed with 1008, the client
treats that as terminal and stops reconnecting, `last_seen_at` goes stale, and
the sweeper reaps a live session as lost. A claim on a session with a recorded
spawn id still requires the matching value. An unknown session or malformed
metadata is rejected rather than being treated as a session without enrollment.

Process ownership is `(instance_id, generation)`, not PID. Each start receives
a random instance id and a monotonically increasing generation. External stop
requests must echo both values and stale ownership fails with
`ownership_mismatch`. Lost-session reaping additionally requires the one-time
spawn id and a matching `start_iso` process generation before PID kill is
eligible.
