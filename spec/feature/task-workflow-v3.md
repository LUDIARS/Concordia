# Task workflow v3.0 — Actio authority

Target release: 3.0.0. Source: neco, 2026-09-08; Pf fragment 01M206XEV4JRC1N3PMEZGGN2P5. The manifest version is not edited here: Revisor syncs `package.json` from the release version file just before publishing, so this line states the intended release, not the current manifest value.

This supersedes the Markdown-authority and Memoria-reconciliation rules in task-workflow.md.
UX: UX-CC-W1/W2/W5, scenarios S1/S2/S3. Invariants: CC-INV-01/02/03/04.
Domain: taskflow (task ownership and execution references); Actio owns task content and business status.

- Create and retrieve task content through Actio. Do not create task Markdown, scan it during normal operation, or fall back to Cc body storage.
- Cc retains opaque task references and execution associations. Task retrieval requires a configured project/organization binding and an authenticated Actio identity.
- Unknown outcomes are reconciled using stable source identities. A retry must not create another task.
- Actio unavailability, missing credentials and ownership mismatches are explicit failures, never an empty task list.
- Agent instructions and continuation events contain task references. Fetch content when needed; do not automatically copy task content into PR descriptions.
- Existing task files and Memoria data are not deleted. Migration is an explicit operation with a stable source identity, not a background scan. Existing copies and historical logs require a separately authorized retention review.
- A successful PR submission is the session completion boundary. No test, restart, merge or production migration is authorized by this specification.

The incident details have not been supplied. This change reduces new copies; it does not claim that existing copies are removed or that all disclosure risks are eliminated.

## Configuration and access

`CONCORDIA_ACTIO_TASK_BINDINGS` is a JSON array. Each entry declares `repoPath` (absolute main clone path), `project` (repository name), `projectId` (Actio project reference), `ownerId` (authenticated Actio owner), `tokenEnv` (the name of an injected bearer-token environment variable), `subsidiaryId` (null for headquarters), and `teamId` (null for personal tasks). Subsidiary entries require an Actio team. Credentials must come from the existing secret injection mechanism; do not place token values in the binding or repository.

The Actio endpoint is resolved from the Excubitor catalog at request time. `/api/auth/me` must report the configured owner before task I/O. Reads and writes additionally check project, owner, team and workflow source. Missing/ambiguous bindings and identity mismatches stop task operations. A Git worktree is resolved to its main clone using Git metadata only.

Example (identifiers are placeholders):

```json
[{"repoPath":"C:/workspace/Concordia","project":"Concordia","projectId":"<Actio project ID>","ownerId":"<Actio user ID>","tokenEnv":"CONCORDIA_ACTIO_TASK_TOKEN","subsidiaryId":null,"teamId":null}]
```

The service can start without task credentials, but task operations then fail explicitly. This is not an offline backend. Actio's current list API returns descriptions along with metadata: Cc processes those responses transiently, excludes taskflow HTTP responses from caching, and does not persist descriptions in the execution ledger. This does not promise that task bodies never enter process memory.

## Agent contract

### Explicit local deployment

UX-CC-W1/W2/W5 and CC-INV-01/02/03/04 apply: Actio owns task content/status;
Cc owns execution references and validates repository, project and organization.
The local adapter must preserve those boundaries even when no bearer credential is used.

Bindings may explicitly select `authMode: "loopback"`, with `ownerId: "actio-local"`,
no `tokenEnv`, and null team/subsidiary. This is only for headquarters personal tasks
on the existing Actio local deployment. The adapter uses the catalog port at
`127.0.0.1`, rejects redirects, and requires `/api/auth/me` to report the configured
owner, `localMode: true`, and `access: "loopback"` before each task operation.
Missing bearer credentials never select local authentication automatically.
Bearer bindings must reject local-mode responses, which do not establish that the
bearer credential was verified. Subsidiary/team rollout remains separately scoped.
This authentication contract is `CC-AT-LOCAL-01`.

The existing `CONCORDIA_ACTIO_TASK_BINDINGS` environment setting takes precedence.
When absent, bindings can be supplied as `actioTaskBindings` in Excubitor's encrypted
per-service runtime configuration (`EXCUBITOR_SERVICE_CONFIG_JSON`). The value is
validated using the same binding schema; malformed or empty configuration fails
explicitly. No tokens, task bodies or machine-specific paths are committed here.
Changing encrypted runtime configuration requires an authorized Cc restart.
Configuration precedence and fail-closed validation are `CC-AT-CONFIG-01`.
The catalog endpoint takes precedence over historical process observations;
an explicitly invalid catalog port fails rather than selecting an old endpoint
(`CC-AT-PORT-01`).

Acceptance covers explicit-mode validation, identity/transport mismatch denial,
catalog-port precedence over stale observations, unchanged bearer requests, and
post-deployment task create/read/status/idempotency verification. Existing tasks
are not migrated automatically. Rollback removes the new configuration and stops
dispatch; it does not re-enable Markdown writes.

- `POST /v1/taskflow/tasks`: `{session_id, request_id: UUID, title, body, kind?, memory_links?, due_at?}`. Returns `reference: actio:<id>` and `repo_path`. Reuse the same request ID for retries; changed content with the same identity is rejected.
- `GET /v1/taskflow/tasks/content?session_id=...&reference=actio:...`: resolves the requesting session's repository and organization before reading the task. The existing Cc API access boundary remains in force; a session ID is a routing identifier, not a new authentication credential.
- `PATCH /v1/taskflow/tasks/state`: use the returned `repo_path` and `task_path=actio:<id>`. Actio owns business status; Cc stores execution associations. Organization reassignment through this endpoint is rejected.
- Normal task lookup and residual generation never instantiate the legacy Markdown store or Memoria reconciler.
- Implementation delegation moves the rendered request to Actio before persisting its run, queue payload or prompt file. Those artifacts contain references and operational metadata. Existing implementation queues without an Actio reference stop for explicit migration.
- The morning scheduler reads Actio deadlines, groups references by project/organization, and dispatches within that repository. Confirm intake creates Actio confirmation tasks using a stable PR identity.
- PR descriptions are authored from the change and verification scope. The automatic task-Markdown-to-PR loader is disconnected.

## Explicit migration

`POST /v1/taskflow/tasks/import` accepts `{session_id, source: "memoria" | "markdown", source_id, title, body, status, kind?, memory_links?, due_at?}`. Select source records within the authorized project before calling it. Use the Memoria record ID (with instance qualifier if needed) or the stable repository-relative legacy task path as `source_id`. For Markdown, read status and execution information from Cc's old ledger rather than trusting stale frontmatter. Map Memoria todo/doing/done to pending/delegated/done; preserve cancelled. The current session determines the destination project and organization.

The importer holds the submitted body only for the Actio operation and returns the new reference. A lost response can be retried with the same source identity; it does not create a second Actio task. Keep the response-to-source mapping in the authorized migration record, and read the destination back before changing operational references. Update the current task to the new reference; task files are never silently followed as a fallback. No batch migration or deletion runs on boot.

Old files, historical Cc records, old prompt files, transcript caches, Memoria records, the separate personal fallback-task API, and legacy non-taskflow integrations are not purged by this release. User-authored manuals may still contain old file instructions; review them before rollout. Backend migration 110 upgrades shipped built-in instructions and adds the Actio confirmation reference; it preserves unrelated custom instructions.

## Validation and rollout

Production TypeScript compilation is checked without emitting files. Unit coverage accompanies the Actio route: binding validation and repository-key normalization, worktree-to-main-clone identity, transport owner verification and unknown-outcome reporting, ownership scoping and source-identity deduplication in the task client, store binding resolution and one-delegation-per-task claiming, the create/import/content API contract, delegation body sealing, morning grouping, decomposition exactly-once, and migration 110's instruction upgrade. These are offline tests against injected doubles; they do not exercise a live Actio instance. Required later checks against a real service: authenticated owner/team isolation, missing credentials, timeout-after-commit retry, duplicate input conflict, queued-run migration, residual idempotency, task status updates, confirmation completion and an agent fetching its task without a body-bearing prompt file. No startup or runtime test is authorized in this session.

Rollout requires configured bindings/credentials, explicit source migration as appropriate, and a separately authorized Excubitor restart from the main clone. Rollback must not silently restore task-file writes: stop task dispatch first and retain Actio references. This PR does not update live configuration, migrate production records, restart services or merge.

Actio-side rollout gate (source inspection, not a runtime finding): the current `modules/task/routes.ts` single-task GET checks team access but does not check ownership for personal tasks; `src/middleware/auth.ts` continues invalid authentication as anonymous. Cc's response validation cannot protect direct Actio access. Before importing sensitive tasks, enforce authenticated access and personal/team authorization on Actio's task surfaces, and verify denial with separately authorized tests. This Cc PR does not implement those Actio changes. A task-only service credential scoped to the intended project/team and a metadata-only listing API are recommended follow-ups; the existing source/sourceRef uniqueness already supplies creation deduplication.
