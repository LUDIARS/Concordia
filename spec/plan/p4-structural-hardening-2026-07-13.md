---
type: plan
title: "P4 structural hardening — shared platform paths, web decomposition, YAGNI"
description: "FIXLIST-2026-07-12 P4-1〜P4-6 の実装判断と受入基準。追加マイクロサービス化を避け、既存worker境界、platform共通化、Web責務分割、設定縮退を完了する。"
service: concordia
domain: architecture
status: active
updated: 2026-07-13
related:
  - process-isolation-v2.md
  - refactor-3axis-architecture.md
  - ../interface/service-schema.md
---

# P4 structural hardening

## 1. Scope and decisions

| P4 | Decision | Deliverable |
|---|---|---|
| P4-1 monolith extraction | No additional service or database split. `cost-worker`, `chat-worker`, and `workflow-worker` already isolate the high-risk workloads. Metrics must stay in core because it supplies rollout/rollback evidence. Processes stays a core-side adapter; RWF stays behind its existing injected plugin boundary. | Tighten dependency rules and document ownership. |
| P4-2 platform convergence | Implement. Move session inject + Codex Enter fallback, standalone reaction classification, and text transcript relay policy into `src/platform/`. | Discord and Slack call the same policy functions. Slack no longer relays Codex commentary frames. |
| P4-3 web decomposition | Implement by responsibility, not by arbitrary line chunks. | The six listed page/settings files become composition shells; data hooks, types, and feature panels live in dedicated modules. Target: each changed source file under 500 lines. |
| P4-4 YAGNI | Redis becomes explicit opt-in. Replace per-route HTTP TTL env knobs with a small fixed policy table. Persona injection stays off by default. Reply-spawn Haiku judgment becomes explicit opt-in. | No Redis connection attempt without `CONCORDIA_REDIS_ENABLED=1`; remove route-specific TTL knobs; document the remaining switches. |
| P4-5 workflow worker | Implemented in PR #323. | Audit lease, durable queue, embedded fallback, docs, tests. |
| P4-6 chat worker v2 | Implemented in PR #323 through S4 code. Production rollout remains an operational decision. | Audit C1–C5. Do not enable worker mode or mutate production state in this change. |

## 2. Dependency and process boundaries

- `core` may compose metrics/process administration but must not import Discord or Slack adapters outside composition roots.
- `platform` contains transport-neutral policy only; it must not import Discord or Slack SDKs.
- Discord and Slack are parallel adapters and must not import one another.
- worker processes share SQLite WAL as the read model/durable queue; no second database and no synchronous chat-to-core RPC is introduced.
- process modes remain `embedded` by default. Rollout requires ACK success-rate and event-loop-lag comparison from `process-isolation-v2.md`.

## 3. Acceptance criteria

1. One common session-inject implementation is used by Discord and Slack, including the best-effort Codex Enter fallback.
2. One common transcript text policy handles assistant/final-answer/summary filtering, ask-marker stripping, and guardian/content filtering.
3. Standalone reaction input has one platform-neutral classification result (`workflow`, `unsupported-emoji`, `prompt`).
4. The six P4 web files are decomposed into independently named responsibilities; no replacement God component is introduced.
5. Redis is silent and unopened by default. HTTP caching has no route-specific TTL env matrix.
6. `npm run lint`, `npm test`, web typecheck, and dependency-cruiser pass.
7. No service is started directly and no production DB or worker mode is changed by this branch.

## 4. Non-goals

- npm workspaces or package-per-process conversion.
- database split or new network service.
- URL/API contract changes.
- production worker rollout or DB maintenance execution.
- visual redesign of the Web UI.
