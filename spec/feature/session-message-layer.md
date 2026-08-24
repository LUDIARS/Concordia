---
type: feature
title: "Session message layer — canonical work stream"
description: "Projects session events into a durable, display-ready message stream shared by internal Web and chat adapters, with cursor pagination, per-client unread state, lifecycle cleanup, and bounded retention."
service: concordia
domain: session-message-layer
owner: Concordia
tags:
  - session-coordination
  - event-projection
  - sqlite
  - rest-api
  - websocket
  - unread-state
status: implemented
related:
  - ./trust-boundaries.md
  - ../interface/service-schema.md
  - ../data/schema.md
updated: 2026-08-07
---

# Session message layer — canonical work stream

## 1. Scope

This phase introduces the durable message layer used as the canonical, display-ready session work
stream. It includes SQLite storage, event projection, in-process and WebSocket events, REST listing
and read-state updates, and per-browser read cursors.

Discord delivery switching, Web UI rendering, Web Push, and delivery edit/delete propagation are
later phases and are not implemented here. `session_message_delivery` is reserved for that later
delivery phase and has no writer in this phase.

## 2. Data flow and ownership

```
ConcordiaEvent
  -> pure projector (`src/messages/project.ts`)
  -> `session_messages` upsert
  -> `session.message` + `session.message.summary`
  -> internal Web/chat consumers
```

`SessionMessageService` owns one event-bus subscription per backend instance. Backend shutdown must
unsubscribe it before closing SQLite so a restart in the same process cannot retain a listener bound
to a closed database.

The sweeper purges `session_messages` by last edit/creation time with the same retention window as
`transcript_logs` (`CONCORDIA_TRANSCRIPT_LOG_RETENTION_DAYS`, with a 7-day default).

## 3. Storage contract

### 3.1 `session_messages`

One row is one rendered stream item. IDs are monotonically increasing SQLite row IDs and are the
pagination/read cursors. `UNIQUE(session_id, dedupe_key)` makes deterministic projections idempotent;
a null dedupe key always inserts. `session.inject` uses the null-key path because its source event has
no stable unique ID; deriving identity from second-resolution time and text would incorrectly collapse
legitimate repeated input.

JSON columns (`embeds`, `components`, `attachments`, `metadata`) are serialized by the repository.
Malformed stored JSON is treated as null; it is never evaluated or used for object construction.
Their transport/storage-neutral TypeScript contract lives in `src/shared/session-message-types.ts` so
the persistence layer does not depend on projector implementation details.

### 3.2 Update semantics

Projector updates are patches over the existing canonical row. Fields omitted by an update retain
their stored value. Metadata keys are merged. This is required for stateful items:

- Task completion replaces result/status fields but retains the original task label.
- Question answer/resolution updates retain the prompt, choices, requester platform, and prior answer
  state.

If an update arrives without an existing row, the repository creates a best-effort row from the
available fields; normal event order creates the source row first.

### 3.3 Data minimization

The message layer intentionally stores message/transcript content for the internal administrator
stream. It must not additionally persist credential-bearing raw permission inputs, platform user IDs,
or full source identifiers in message metadata. Permission actions retain only `request_id` and
`tool_name`; question state retains the question/answer data needed to render it.

Concordia HTTP remains an internal loopback API. Any external exposure must pass through
AccessControl as specified in [trust-boundaries.md](trust-boundaries.md).

### 3.4 `session_message_reads`

Read state is keyed by `(client_id, session_id)`. `client_id` is a browser-generated opaque ID of
1–128 characters. A read cursor is monotonic: stale writes cannot move it backward. The API clamps a
submitted cursor to the latest existing message ID in that session so a forged future ID cannot hide
subsequent messages.

## 4. Projection contract

The projector handles these events:

| Source | Result |
| --- | --- |
| transcript text/thinking/summary/image | user, assistant, thinking, summary, or attachment message |
| tool use/result | tool message, or one Task row updated through completion |
| `session.inject` | user message with normalized platform only |
| question posted/answered/resolved | one question row with retained prompt/options and merged state |
| permission request | permission item without raw `tool_input` persistence |
| delegation mirror | delegation item |
| operational claim opened/released | system item |

Unknown events and unsupported transcript frame kinds produce no message.

## 5. REST API

All routes return 404 for an unknown session.

| Method | Path | Contract |
| --- | --- | --- |
| `GET` | `/v1/sessions/:id/messages` | `before` or `after` exclusive integer cursor; optional positive `limit`; latest 50 by default, repository cap 200; chronological response |
| `GET` | `/v1/sessions/:id/messages/unread?client_id=...` | Returns `last_read_id` and the count of rows after it |
| `POST` | `/v1/sessions/:id/messages/read` | JSON `{ client_id, last_read_id }`; stores the bounded monotonic cursor and returns the effective cursor |

Malformed cursors, simultaneous `before` and `after`, unsafe integers, invalid JSON, and invalid client
IDs return 400. SQL values are always bound parameters.

## 6. Event contract

- `session.message`: `{ target_session_id, op: "create" | "update", message, ts }` where `message`
  is the serialized canonical row.
- `session.message.summary`: `{ target_session_id, latest_id, ts }`, a lightweight signal for clients
  to refresh unread state.

Consumers must treat message text and JSON fields as untrusted display data. Neither event causes
command execution, path access, deserialization into executable types, or redirects.

## 7. Automated evidence

Repository tests cover idempotent upsert, update collapse, pagination, context restoration, retention,
monotonic read cursors, and safe JSON parsing. Service tests cover projection/emission, Task updates,
question-state preservation, metadata minimization, and subscription cleanup. API tests cover valid
listing, invalid/ambiguous cursors, client-ID validation, cursor bounding, and unread counts.
