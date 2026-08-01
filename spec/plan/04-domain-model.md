---
type: plan
title: "Concordia domain model baseline"
service: concordia
domain: analysis-core
status: complete
updated: 2026-07-16
---

# Domain model

## Authority

The ten names and descriptions below are copied byte-for-byte from `spec/data/ontology/*.domain.json`. They are the human-approved meaning baseline passed to Anatomia as `source: manual`, `lockedFields: ["*"]`. Membership evidence is measured separately.

| Bounded context | Exact description | Core model elements |
|---|---|---|
| `session-coordination` | Core purpose: track concurrent AI coding agent sessions — register, share progress, detect lost sessions, recover from jsonl, resume, and generate end-of-session reports. | Session, SessionEvent, PendingTask, Report, RecoveryCandidate; register/update/end/resume; session-lost/report-generated events |
| `chat-platforms` | Bidirectional chat-platform integration that surfaces session state and accepts control input over Discord and Slack, including reaction-driven dispatch and synthetic personas. | ChatSurface, RelayFrame, Question, ReactionAction; post/relay/answer; platform delivery events |
| `agent-delegation` | Agent delegation, persona generation, subsidiary bots, harness sessions, and advisory testing claims that coordinate work beyond a single session. | DelegationTemplate, DelegationRun, Persona, Subsidiary, TestingClaim; invoke/claim/release; delegation lifecycle events |
| `http-interface` | External access surfaces: the HTTP/Hono REST API that hooks report to, the MCP server, and the web monitoring frontend. | API contract, route, WebSocket client, MCP tool, read model; validate/request/respond |
| `runtime-orchestration` | Process bootstrap and in-process composition: server entrypoints, route composition, worker modes, event bus, and periodic runtime loops. | CoreRuntime, ChatRuntime, CostRuntime, lease, scheduler; start/stop/reconcile |
| `persistence` | Durable state and cross-cutting infrastructure: SQLite repositories for all entities plus shared config, secrets, and auth helpers. | Repository, transaction, schema, secret, auth policy; persist/query/migrate |
| `observability` | Cost, resource, and time-based reporting: aggregating spend, sampling host metrics, and scheduling daily/morning/stat rollups. | UsageSample, Budget, CostReport, MetricSnapshot; sample/aggregate/report |
| `governance` | Policy and workflow steering: a rule engine that proposes/enacts actions, PR queue reconciliation, role prediction, and admin configuration toggles. | Rule, Proposal, PRQueueEntry, RolePrediction, AdminSetting; evaluate/enact/reconcile |
| `analysis-core` | Core Anatomia analysis engine (session cache, parsing) together with skill frontmatter parsing/analysis and model-catalog seeding that feed the analysis pipeline | AnalysisSession, SkillRecord, ModelCatalogEntry; parse/analyze/seed |
| `tooling` | Automated test suites plus shared test helpers, fixtures, and DB/app/dir factories supporting them | Test fixture, test DB, app factory; arrange/verify/cleanup |

## Cross-context policies and invariants

- Session coordination owns session meaning; HTTP, chat, and MCP adapt that meaning for transport.
- Runtime orchestration owns process lifetime and must release workers, leases, listeners, and timers on all stop paths.
- Persistence owns durable representation but must not become the semantic owner of every context.
- Testing claims are advisory coordination records, not service locks.
- Chat and cost workers may degrade independently; they must not corrupt or redefine core state.
- Provider-specific behavior is behind provider contracts; session identity remains provider-neutral.

## Commands and events

| Context | Representative commands | Representative events |
|---|---|---|
| session-coordination | register session, append event, heartbeat, resume, end, inject task | session started/updated/lost/ended, report generated |
| agent-delegation | invoke template, start/cancel run, claim/release test | delegation queued/started/completed/failed, claim opened/released |
| chat-platforms | ensure surface, relay frame, post question, answer, react | message relayed, question posted/answered, action requested |
| runtime-orchestration | start/stop core or worker, acquire/renew lease, reconcile | runtime ready/stopped, lease acquired/lost, reconcile completed |
| observability | sample usage, aggregate cost, evaluate budget | sample recorded, budget threshold crossed, report published |

## Speculative or disputed boundaries

- `persistence` combines repositories with config, secrets, and auth. **[analysis]** The low measured cohesion may reflect a taxonomy boundary that is intentionally infrastructure-heavy rather than a weak business model.
- `analysis-core` has only 15 measured implementors. **[question]** It may be an emergent subsystem rather than a stable bounded context.
- `tooling` is useful for coverage accounting but is not a product domain. It is reported separately when interpreting product-domain health.
