# Task workflow v3.0 — Actio authority

Target release: 3.0.0. Source: neco, 2026-09-08; Pf fragment 01M206XEV4JRC1N3PMEZGGN2P5. The manifest version is not edited here: Revisor syncs `package.json` from the release version file just before publishing, so this line states the intended release, not the current manifest value.

This supersedes the Markdown-authority and Memoria-reconciliation rules in task-workflow.md.
UX: UX-CC-W1/W2/W5, scenarios S1/S2/S3. Invariants: CC-INV-01/02/03/04.
Domain: taskflow (task ownership and execution references); Actio owns task content and business status.

- Create and retrieve task content through Actio. Do not create task Markdown, scan it during normal operation, or fall back to Cc body storage.
- Cc retains opaque task references and execution associations. Task retrieval requires a resolved project/organization binding and an authenticated Actio identity.
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

### Task session provenance (CC-TF-SESSION-01)

UX-CC-W1/W2, S1/S2/S3: users must retain the issuing session and distinguish it
from the current worker when work is delegated or handed over. Actio owns the
persisted `pluginPayload.issued_by_session_id` and `working_session_id` (nullable
strings); Cc taskflow owns session validation and assignment transitions. Cc's
execution ledger remains a reference/association index, not a second authority.

- A session-created task records its issuing session at creation. Delegation
  records the parent as issuer, and remaining work records the reporting child.
  The issuer is immutable across assignment changes and idempotent create retries.
- Human/system-created and imported/historical tasks can have null or absent
  session fields. Never infer an issuer from legacy `source_session`, a reader,
  or the session importing historical work.
- A newly created task has no worker. Delegated children become workers after
  registration. Explicit task state updates assign/hand over a worker, and
  release or session end clears only that session's assignment. A stale release
  must not erase a successor. Session IDs must match the task repository and
  organization. The old `source_session` update spelling remains a worker alias;
  creation no longer writes the issuer there.
- List/content/overview expose both fields, normalizing missing fields to null.
  Reading a task never claims it. Preserve unrelated plugin metadata on updates.
- Cc serializes metadata changes per task; expected-worker checks reject stale
  updates. Actio is updated before the local association mirror. Unknown remote
  outcomes must be reconciled by reading the same task, not making another task.
  This contract assumes the Cc-owned plugin metadata has one Cc writer; it does
  not introduce cross-server distributed assignment or change Actio authorization.
- Acceptance: distinct parent/child IDs, immutable issuer on retry/handoff,
  old/import null compatibility, explicit claim/release and stale-release denial,
  preserved metadata, scope rejection, and surfaced remote failures. Rollback
  leaves these optional fields in Actio; no historical backfill or live migration.

Approved by neco on 2026-09-26: 「実装とテストを進める」 after design confirmation.
Implementation and regression tests are authorized; service restart is not.

### Explicit local deployment

UX-CC-W1/W2/W5 and CC-INV-01/02/03/04 apply: Actio owns task content/status;
Cc owns execution references and validates repository, project and organization.
The local adapter must preserve those boundaries even when no bearer credential is used.

Bindings may explicitly select `authMode: "loopback"`, with `ownerId: "actio-local"`,
no `tokenEnv`, and null subsidiary. A registered team requires the additional checks in CC-AT-TEAM-01. This is only for headquarters tasks
on the existing Actio local deployment. The adapter uses the catalog port at
`127.0.0.1`, rejects redirects, and requires `/api/auth/me` to report the configured
owner, `localMode: true`, and `access: "loopback"` before each task operation.
Missing bearer credentials never select local authentication automatically.
Bearer bindings must reject local-mode responses, which do not establish that the
bearer credential was verified. Subsidiary rollout remains separately scoped; local teams follow CC-AT-TEAM-01.
This authentication contract is `CC-AT-LOCAL-01`.

The existing `CONCORDIA_ACTIO_TASK_BINDINGS` environment setting takes precedence.
When absent, bindings can be supplied as `actioTaskBindings` in Excubitor's encrypted
per-service runtime configuration (`EXCUBITOR_SERVICE_CONFIG_JSON`). The value is
validated using the same binding schema; malformed explicit configuration fails
explicitly. An absent binding list or an empty array enables local registration discovery.
No tokens, task bodies or machine-specific paths are committed here.
Changing encrypted runtime configuration requires an authorized Cc restart.
Configuration precedence and fail-closed validation are `CC-AT-CONFIG-01`.
The catalog endpoint takes precedence over historical process observations;
an explicitly invalid catalog port fails rather than selecting an old endpoint
(`CC-AT-PORT-01`).

For headquarters personal work, `CC-AT-DISCOVERY-01` resolves the existing repository
project code against Actio's current `/api/projects/cc` registration. No additional
per-repository Actio binding is required. Exact code, Git main-clone identity, and
verified local authentication are mandatory; team registrations are not converted
to personal tasks. Explicit bindings retain precedence. A bearer-only deployment
does not enable local discovery, and invalid credentials never select loopback.
See [Cc worktree creation](implementation-worktree.md) for the creation tool,
ignored reference metadata, ownership, and same-branch recovery contract.

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

### Failure diagnostics and local PR evidence (CC-TF-DIAG-01)

Taskflow owns completion orchestration and safe failure classification; Actio owns
task content/status and Revisor owns local PR state. UX-CC-W2/W3/W5 and
CC-INV-03/04/08 require that unavailable evidence never becomes a missing PR or
successful completion. Interactive completion must pass the Revisor reader to
goal evaluation. A failed Revisor lookup stops evaluation with a dedicated code.

HTTP and runtime boundaries classify known failures into fixed reason codes.
Unknown exceptions are internal failures, not Actio outages. Logs and notifications
must not include raw exception messages, request queries, bodies or credentials.
Existing human-response confirmation deduplication remains in force. API clients
receive a safe reason code and a status distinguishing conflicts, upstream failures,
unavailability and internal errors. Retries retain the original task identity.
Regression checks cover local PR propagation, failed lookup without a PR-missing
notification, safe diagnostics, and preserving existing confirmation waits.

Production TypeScript compilation is checked without emitting files. Unit coverage accompanies the Actio route: binding validation and repository-key normalization, worktree-to-main-clone identity, transport owner verification and unknown-outcome reporting, ownership scoping and source-identity deduplication in the task client, store binding resolution and one-delegation-per-task claiming, the create/import/content API contract, delegation body sealing, morning grouping, decomposition exactly-once, and migration 110's instruction upgrade. These are offline tests against injected doubles; they do not exercise a live Actio instance. Required later checks against a real service: authenticated owner/team isolation, missing credentials, timeout-after-commit retry, duplicate input conflict, queued-run migration, residual idempotency, task status updates, confirmation completion and an agent fetching its task without a body-bearing prompt file. No startup or runtime test is authorized in this session.

Rollout requires Actio registration (or explicit scoped bindings/credentials), explicit source migration as appropriate, and a separately authorized Excubitor restart from the main clone. Rollback must not silently restore task-file writes: stop task dispatch first and retain Actio references. This PR does not update live configuration, migrate production records, restart services or merge.

Actio-side rollout gate (source inspection, not a runtime finding): the current `modules/task/routes.ts` single-task GET checks team access but does not check ownership for personal tasks; `src/middleware/auth.ts` continues invalid authentication as anonymous. Cc's response validation cannot protect direct Actio access. Before importing sensitive tasks, enforce authenticated access and personal/team authorization on Actio's task surfaces, and verify denial with separately authorized tests. This Cc PR does not implement those Actio changes. A task-only service credential scoped to the intended project/team and a metadata-only listing API are recommended follow-ups; the existing source/sourceRef uniqueness already supplies creation deduplication.

## Project-scoped discovery (CC-AT-SCOPE-01)

UX-CC-W1/W2/W5, scenarios S1/S3, CC-INV-01/02/03/04: a user must be able to
retrieve an existing project's tasks without an unrelated project's ambiguous
team registration blocking that lookup. Actio owns content, status, identity and
team membership; Cc owns binding selection and execution references.

Project-scoped list/overview and single-repository operations select candidate
bindings before registration ambiguity checks and task I/O. Project names remain
case-insensitive; repository selectors retain canonical main-clone resolution.
Explicit headquarters bindings suppress discovery for their repository even if
their project label differs. Bearer-only deployments never enable local discovery
when selection yields no configured binding. Organizational checks remain intact.

A selected multi-team project resolves to a team-less binding with its registered
team candidates (CC-AT-TEAM-02); it no longer fails closed. Unscoped queries still validate
all candidates and never silently omit an ambiguous project. Team ambiguity is a
safe HTTP 503 configuration failure, not an opaque HTTP 500. No task, permission,
team assignment or credential is rewritten as part of selection.

Acceptance: valid single-team lookup despite unrelated ambiguity; no unrelated
task reads; selected/unscoped ambiguity rejection; explicit/bearer/subsidiary
isolation; canonical repository identity; unchanged status/organization filters
on list and overview. Rollback reverts selection changes without data migration.
Local test execution, service restart and merge require separate authorization.

## Local team task access (CC-AT-TEAM-01)

UX-CC-W1/W5, CC-INV-02: local discovery preserves exactly one registered teamId instead of converting team work to personal work. Multiple registered teams are handled by CC-AT-TEAM-02; explicit bindings retain precedence. Local subsidiary bindings and bearer-to-local fallback remain forbidden. Every team operation verifies loopback identity and the matching leader entry from Actio /api/teams before task I/O. Actio owns authorization and task state; its task routes must independently enforce the verified local-owner team policy. No team membership, owner privilege, or project assignment is rewritten.

Recovery: deploy the Actio route authorization fix before using team bindings. On authorization or discovery failure, preserve the original task source identity and report failure; do not redirect to personal scope. Acceptance covers single-team preservation, multi-team rejection, missing/wrong/member team denial, and existing identity/subsidiary/bearer rejection cases.

For local team creation Cc sends the verified single local owner as assigneeId, satisfying Actio's required assignee without inventing a different recipient. Personal and bearer bindings keep their existing payload.

## Multi-team projects and explicit delegation team (CC-AT-TEAM-02)

Actio task: `actio:64ae686f-78e7-4c07-9ad1-037cc3e99aa1` (2026-10-01). A project registered to
several Actio teams is a legitimate state (e.g. Cernere in LUDIARS-Foundation and GLab). Tasks
can be filed from either team; a team's backlog only shows tasks on that team.

- Discovery (`src/taskflow/actio-project-binding.ts`): 0 / 1 registered teams keep the previous
  binding. 2+ teams produce one team-less binding (`teamId: null`) that carries
  `teamCandidates` (the registered teamIds). Cc never picks one of them by itself.
- Selection (`src/taskflow/actio-team-selection.ts`, pure): `selectActioTeam(binding, requested)`
  returns the binding unchanged when nothing is requested, uses the requested team only when it
  equals the binding's team or is one of its candidates, and otherwise throws
  `ActioTeamSelectionError` (code `actio_team_invalid`, with the candidate list). A configured
  binding's team is never overridden.
- Scope (`src/taskflow/actio-task-client.ts`): a team-less multi-team binding accepts tasks whose
  team is `null` or one of its candidates, so a team task created by explicit selection can still
  be read, claimed and updated through the repository binding.
- Delegation (`src/delegation/contracts.ts`, `src/delegation/actio-task.ts`, `src/api/delegation.ts`,
  `src/mcp/delegation-server.ts`): `POST /v1/delegation/invoke` and MCP `delegation_invoke` accept an
  optional `actio_team_id`; it is passed to `TaskStore.create` as `teamId`. Without it a multi-team
  project gets a team-less task (Actio accepts `teamId: null`: minimal input mode, no lane or
  assignee requirement, no team/project membership check).
- Failure (`src/delegation/seal-failure.ts`, `src/delegation/service.ts`): when sealing fails, the
  invoke error keeps the historical text and adds `detail: { code, message }` from
  `src/taskflow/failure.ts`. When the binding is multi-team, `detail.candidate_team_ids` and a hint
  to pass `actio_team_id` are added. Raw exception text, tokens and configuration values are never
  returned.

Recovery: pass `actio_team_id` with one of `candidate_team_ids`, or omit it for a team-less task.
Rollback reverts these files; no data migration is involved.

## CC-TASK-MERGE-END-01: マージまで委託を継続する

価値 UX-CC-PRODUCT。利用者が失うと困る状態は、PR提出後に委託セッションが終了し競合修正・再審査・マージが取り残されること。
状態所有者: PR状態はRevisor、終了ladderはCc taskflow。不変条件: open/missingのPRでは自動終了しない。mergedかつ残作業noneかつ未回答質問なしの場合だけ、対象runの子セッションの終了を予約する。親や対話セッションを終了しない。
既存のマージ許可を再質問せず、審査ゲートと人間判断要求は維持する。検証はsession-end.test.tsとruntime.test.ts（mergedで子を終了、openでは継続）、復旧は終了判定の変更をrevertする。永続状態の移行なし。

## CC-TF-EXEC-01: 実行状況 (サイドカー) の可視化

価値 UX-CC-W2 (委任後も仕事を見失わず、重複依頼せずに再開できる)、補助で UX-CC-W3。
利用者が失うと困る状態は、委託した仕事が「受け取られたか」「いま何をしているか」「なぜ止まったか」が
Taskflow 画面から分からず、セッション一覧や Discord を辿らないと再開・再依頼の判断ができないこと。

Taskflow の各行に、タスクの業務状態 (`status`、正本は Actio / task state) とは別の **実行状況** (`execution`) を出す。
両者を一つの値に混ぜない。実行状況は委託 run・子セッション・PR・transcript から毎回導出する読み取りモデルで、保存しない。

| 項目 | 意味 | 導出元 |
|---|---|---|
| `state` | `not_started` / `queued` / `launching` / `received` / `working` / `waiting` / `stopped` / `finished` | run の status、子セッションの status |
| `assignee` | 担当 (既存の `assignee` と同じ) | runtime → session metadata → run |
| `received_at` | 受領した時刻 (子セッションが起動した時刻) | 子セッションの `started_at` |
| `current_action` | いま何をしているか。最後の tool 名、または作業中のタスク名 | transcript の最新 `tool-use` の `name` / session `current_task` |
| `last_response` | 最後の応答 (先頭 280 文字) と時刻 | transcript の最新 assistant `text` |
| `stop_reason` | 止まった理由。止まっていなければ null | run の `error`、`blocked` / `failed` / `spawn_failed`、子セッションの終了 |
| `artifacts` | 成果物リンク: PR、作業ブランチ | PR 記録、run の `spawn_branch` |

- 状態所有者: run 状態は delegation、セッション状態は sessions、PR は pr_records (Revisor 由来)。この読み取りモデルはどれも書き換えない。
- 不変条件:
  - CC-TF-EXEC-INV-01: 実行状況はタスクの業務状態を上書き・推定しない (`status` と `execution.state` は独立)。
  - CC-TF-EXEC-INV-02: tool の入力 (`input_preview`) は出さない。出すのは tool 名だけ。応答本文は 280 文字で切る。
  - CC-TF-EXEC-INV-03: transcript の読み出しは表示対象行の子セッション (最大 100 件) に限り、各セッションの末尾 50 行だけを (session_id, ts) index で引く。末尾 50 行に無い項目は null (CC-NODE-01)。
  - CC-TF-EXEC-INV-04: 導出できない項目は null とし、推測で埋めない。
- 復旧: 読み取り専用で永続状態の移行は無い。不具合時は該当 PR を revert する。
- 検証: `src/taskflow/execution-view.test.ts` (状態導出・停止理由・応答切り詰め・tool 入力非表示)、`src/db/transcript-logs-repo.test.ts` (最新行の一括取得)。
