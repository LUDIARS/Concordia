# ドメイン taxonomy: concordia

自己調整パイプライン（[domain-retune](./domain-retune.md)）が生成。反復 2 回。
このファイルは生成物。手で編集せず `npm run retune` で再生成する。

## chat-platforms

Bidirectional chat-platform integration that surfaces session state and accepts control input over Discord and Slack, including reaction-driven dispatch and synthetic personas.

- **discord** — Discord bot, control UI, session channels, and command handlers (src/discord, src/discord/commands).  `paths: (^|/)src/discord/[^/]+$, (^|/)src/discord/commands/[^/]+$`
- **slack** — Slack bot, message/thread mapping, and session mirroring repos (src/slack).  `paths: (^|/)src/slack/[^/]+$`
- **reaction-workflow** — Emoji-to-action mapping, workflow planning, and runner harness (src/platform, src/triggers).  `paths: (^|/)src/platform/[^/]+$, (^|/)src/triggers/[^/]+$`
- **personas-delegation** — Dynamic persona generation from signals and delegation templates (src/personas, src/delegation).  `paths: (^|/)src/personas/[^/]+$, (^|/)src/delegation/[^/]+$`

## http-interface

External access surfaces: the HTTP/Hono REST API that hooks report to, the MCP server, and the web monitoring frontend.

- **rest-api** — Hono routers for sessions, spawn, reports, and other v1 endpoints (src/api).  `paths: (^|/)src/api/[^/]+$`
- **web-monitor** — Vite+React Foundation UI pages, components, and hooks for live monitoring (web/src).  `paths: (^|/)web/src/pages/[^/]+$, (^|/)web/src/pages/settings/[^/]+$, (^|/)web/src/[^/]+$, (^|/)web/src/components/[^/]+$, (^|/)web/src/hooks/[^/]+$`
- **mcp-server** — MCP tool surface exposing Concordia queries to agents (src/mcp).  `paths: (^|/)src/mcp/[^/]+$`
- **web-client** — Browser-side UI library (rendering, connection, event wiring) and host/config loading that front the HTTP interface  `paths: (^|/)web/src/lib/[^/]+$, (^|/)web/[^/]+$`

## session-coordination

Core purpose: track concurrent AI coding agent sessions — register, share progress, detect lost sessions, recover from jsonl, resume, and generate end-of-session reports.

- **session-lifecycle** — Session registration, heartbeat, end flow, spawn and reaper control (src/control, src).  `paths: (^|/)src/control/[^/]+$, (^|/)src/[^/]+$`
- **worktree-automation** — Parallel git worktree detection and management for same-repo/branch sessions (src/work, src/processes).  `paths: (^|/)src/work/[^/]+$, (^|/)src/processes/[^/]+$`
- **session-reports** — LLM summarization plus structured aggregation of session events into reports (src/report).  `paths: (^|/)src/report/[^/]+$`
- **lost-recovery** — Heartbeat sweeper, jsonl transcript parsing, and lost-session candidate handling (src/providers, src/work).  `paths: (^|/)src/providers/[^/]+$`

## persistence

Durable state and cross-cutting infrastructure: SQLite repositories for all entities plus shared config, secrets, and auth helpers.

- **repositories** — SQLite-backed repos for sessions, participants, channels, PRs, and more (src/db).  `paths: (^|/)src/db/[^/]+$`
- **config-secrets** — Config loading, secret resolution, encryption, and bearer extraction (src/shared, src/auth).  `paths: (^|/)src/shared/[^/]+$, (^|/)src/auth/[^/]+$`

## observability

Cost, resource, and time-based reporting: aggregating spend, sampling host/WSL metrics, and scheduling daily/morning/stat rollups.

- **cost-tracking** — Cost feed aggregation and usage rate reading across providers (src/cost).  `paths: (^|/)src/cost/[^/]+$`
- **host-metrics** — Host and WSL process/resource snapshots and capture (src/metrics).  `paths: (^|/)src/metrics/[^/]+$`
- **scheduled-reports** — Daily, morning, and stat schedulers driving periodic reports (src/daily, src/morning, src/stat).  `paths: (^|/)src/daily/[^/]+$, (^|/)src/stat/[^/]+$, (^|/)src/morning/[^/]+$`

## governance

Policy and workflow steering: a rule engine that proposes/enacts actions, PR queue reconciliation, role prediction, and admin configuration toggles.

- **pr-queue** — PR ingestion, reconciliation, and queue building (src/pr).  `paths: (^|/)src/pr/[^/]+$`
- **rules-engine** — Rule evaluation, proposal, and action execution (src/rules, src/role).  `paths: (^|/)src/rules/[^/]+$, (^|/)src/role/[^/]+$`
- **admin-settings** — Workspace, chat, and feature toggle administration (src/admin).  `paths: (^|/)src/admin/[^/]+$`

## analysis-core

Core Anatomia analysis engine (session cache, parsing) together with skill frontmatter parsing/analysis and model-catalog seeding that feed the analysis pipeline

- **anatomia-engine** — Core Anatomia analysis engine (session cache, parsing) together with skill frontmatter parsing/analysis and model-catalog seeding that feed the analysis pipeline  `paths: (^|/)src/anatomia/[^/]+$, (^|/)src/skills/[^/]+$, (^|/)src/model-catalog/[^/]+$`

## tooling

Automated test suites plus shared test helpers, fixtures, and DB/app/dir factories supporting them

- **test-harness** — Automated test suites plus shared test helpers, fixtures, and DB/app/dir factories supporting them  `paths: (^|/)tests/[^/]+$, (^|/)tests/helpers/[^/]+$`

