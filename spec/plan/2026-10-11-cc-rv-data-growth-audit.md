# Cc/Rv response latency and data-growth audit

Date: 2026-10-11. Status: investigation complete for the sampled paths; targeted Cc fix prepared, tests and runtime reflection pending. Recommendations below are not implemented or approved retention policies.

## Scope and authorization

Human request: investigate Cc stalls and response latency, prepare the fix, and investigate Cc/Rv optimization, rotation and caching as data grows. The follow-up explicitly asks for investigation rather than a keyword search.

Cc base: `28fda4131fa4808e381c6a700806327d0b014942`; task branch: `fix/forum-phase-active-reconciliation-20261011`. Rv inspected source: `3bbcec6df66798dff85b65b77d1d69a23aefe598`. Rv source was not edited. Live services can differ from source: Cc health reported `build_stale: true` during investigation. No service was started, stopped or restarted; no production data was changed or deleted by the measurements.

Actio correspondence remains **unknown**: Cc returned no task links for this session and the catalog-resolved Actio endpoint could not be reached. No task ID or completion state was invented. Human implementation authorization is the explicit instruction “修正作って”, not an injected policy or legacy work-phase value.

## Findings and priority

| Priority | Boundary | Evidence | Next change and acceptance criterion |
|---|---|---|---|
| P0, prepared | Cc forum phase title reconciliation | Every 60 seconds, retained channel history was enumerated before expensive ownership checks. Equivalent read-only replay: 3,380 scoped rows, 22,009 queries, 1,640–1,776 ms; active-thread prefilter: 6 candidates, 55 queries, 14–21 ms. | Use the existing scoped `listActive()` and reject non-thread/inactive/missing sessions before ownership resolution. Preserve all post-fetch checks. Growing ended history must not grow ownership calls. |
| P1 | Rv dashboard polling | `ui-dashboard-page.mjs:99–149` requests jobs, repositories, local PRs and releases every 3 seconds. `/api/local-prs` defaults to full/all (`ui-server.mjs:247`). Equivalent live `/v1/local-prs` response: 21,584,047 bytes, 411 ms for one sample. | Dashboard only needs open counts: request summary/open, or a counts endpoint. Refresh after completion, prevent overlapping requests, suspend when hidden; version/ETag conditional responses for unchanged data. Keep detailed/history views on demand. |
| P1 | Rv list cache invalidation and query scope | `StateStore.listVersion()` uses database-wide `PRAGMA data_version`; queue writes invalidate PR lists too. On a miss `listPullRequests()` reads every PR before `state` filtering. 2,676 PRs: 13 open, 2,381 merged, 282 closed. Reading raw PR records alone: 109 ms / 20.53 MB, excluding JSON parsing and decision computation. | Transactionally increment a PR-list revision for changes affecting list/decision/report versions; preserve invalidation on settings changes. Query status/repository with indexes before parsing, plus stable pagination for history. A jobs-only write must not rebuild an unchanged PR list; another process's PR update must invalidate it. |
| P1 | Cc terminal Test Forum synchronization | `revisor-test-workflow-client.ts` uses `/v1/local-prs?view=summary` for terminal reconciliation, then filters locally. Live all-summary response: 2,281,131 bytes versus open-summary 13,770 bytes. A 5-second shared cache already exists. | Ask for the IDs of still-open local forum surfaces, or consume changes with a persisted cursor plus bounded recovery reconciliation. Preserve recovery after missed notifications and closing of formerly open surfaces. Merely extending TTL leaves total-history transfer intact. |
| P2 | Cc escalation transcript intake | `listFramesContaining` searches payload with `%ESCALATION%`, a 24-hour predicate, ascending time/seq, limit 1,000. Read-only plan: full transcript scan plus temporary sort. Three earlier samples: 113/107/108 ms, zero matches; 10,812 recent rows / 2,239,559 payload bytes. | First add an appropriate time/order access path and verify the plan. Then consider ingestion-time marker projection or durable cursor. Cursor advances only after the batch is processed; use a monotonic ingestion identity or handle late/equal timestamps explicitly. Preserve deduplication and retry on failed writes. |
| P2 | Rv queue JSON scans | Jobs are already bounded to 200 settled-history records. Status/summary access uses `json_extract(record, ...)` against the whole table, including stored request payloads. Current active query: 28 ms returning zero jobs; three-field summary: 30 ms for 200 jobs. Only primary-key indexes were present in the inspected DB. | Store/index queue status, key, timestamps and small summary fields separately from large request JSON. Read request only when claiming/inspecting one job. Verify atomic state transitions, duplicate-key decisions and cross-process claiming. |
| P2, policy/design required | Rv durable history storage | Main DB was 2,443,563,008 bytes at 09:01 UTC. PR records accounted for 20,533,032 bytes; separate Anatomia rows: 2,624; report rows: 942; jobs: 200. Remaining bytes have not been fully attributed. Free pages: 2,078 of 596,573, so ordinary free-space reclamation alone cannot explain most size. | Attribute side-table payloads with bounded offline sampling, then define archival of terminal artifacts with a durable manifest, hashes and lazy retrieval. Keep PR identity, head, decision evidence and audit references. Do not expire active jobs or needed review evidence. Decide retention with the owner before deletion. |
| P3 | Cc operational log rotation | Rotation already exists: 128 MiB / 5 generations by default, but runs only before pino opens the file. Current live log ~34.7 MB; five generations ~134.5–158.3 MB each. Current sample does not show uncontrolled active growth. | If long uptime growth is observed, use a writer-owned close/reopen rotation or supported rotating transport. Do not rename an open Windows file from a maintenance timer. Observe byte rate and repeated-message concentration before implementing. |

## Measurements and limits

The periodic stall was observed in `logs/concordia/cc-live.jsonl` around 06:29–06:41 UTC (15:29–15:41 JST), often with zero in-flight requests. A health request at 06:41:06.243 UTC took 1,586 ms; the event-loop log at 06:41:07.998 UTC recorded 1,764 ms lag. The periodic forum sweep reproduces this order of cost. This identifies a concrete latency source; it does not attribute every outage or every slow request to the same cause.

The replay used a separate read-only SQLite connection and equivalent ownership/consultation reads, not the patched running service. The active-thread prefilter replay is narrower than the patch's repository `listActive()` (which also allows active non-thread rows to reach the cheap predicate). Query counts and timing are comparative evidence, not a promised production speedup or executed regression test.

Live Rv GET samples around 09:03–09:06 UTC (18:03–18:06 JST):

| Request | HTTP | Response bytes | Elapsed, one sample |
|---|---:|---:|---:|
| `/v1/local-prs?view=summary&state=open` | 200 | 13,770 | 5.3 ms |
| `/v1/local-prs?view=summary&state=all` | 200 | 2,281,131 | 22.1 ms |
| `/v1/local-prs?state=open` | 200 | 137,286 | 3.3 ms |
| `/v1/local-prs` | 200 | 21,584,047 | 411.1 ms |

These are single loopback samples, likely benefiting from existing server caches, not load-test percentiles. The dashboard `/api` endpoint itself was not fetched; its matching defaults and serialization path were inspected. If the default full response is fetched every 3 seconds, it represents approximately 432 MB/minute per open dashboard before any transport compression. This is a calculation from source and response size, not an observed aggregate traffic rate. No active-dashboard count was measured.

Rv SQL measurements used `node:sqlite` with `readOnly: true`, not the application store initializer (which can migrate schema). An attempted aggregate of all large side-table payload lengths exceeded the 20-second child-process limit and was stopped. Exact per-side-table byte attribution is therefore pending; no claimed size breakdown is inferred from that timeout. Short follow-up count queries and targeted plan/timing queries succeeded.

Cc's earlier DB sample was 915,386,368 bytes; read-only `quick_check(1)` returned `ok`. Integrity checks do not establish acceptable latency. No VACUUM, checkpoint, DELETE or retention adjustment was performed.

## Existing mechanisms to retain

- Cc `SharedReadCache`: TTL + single-flight, failed requests are not cached, invalidation prevents a stale in-flight result from being reinserted. Test Workflow client defaults to 5 seconds and shares service lookup too. Do not add a second overlapping TTL layer or cache authorization/merge decisions.
- Rv `PrListCache` caches projections by source version and decision settings; `ListResponseCache` caches serialization. Review reports and Anatomia are already separate from ordinary PR lists. Reports are loaded on explicit demand. The remaining problem is read scope and broad invalidation, not absence of caching.
- Rv queue retention already trims settled jobs toward 200 and never evicts queued/running work for the count cap; PR event history is capped at 50. Do not suggest deleting active work to enforce a hard cap.
- Cc log archive/purge is already restricted to 01:00–02:59 JST, with nightly VACUUM at 03:00. Preserve the separate archive-before-delete and failure-retention behavior. Repeated scans of ended sessions should be fixed at the query boundary, not by destroying history.

## Implemented boundary and acceptance

Domain: **chat-platforms**, a supporting adapter boundary for core session-coordination. UX: `UX-CC-W1`, `UX-CC-W4`, `UX-CC-W5`; scenarios `UX-CC-S1/S5/S6`. The user must retain a responsive, correctly scoped view of current work, without an ended or rebound session being revived by a delayed Discord response.

SpecRefs: `spec/ux/product.md`, `spec/architecture/ddd.md`, `spec/feature/session-work-phases.md#discord-スレッド名-cc-discord-phase-title-01`. Invariants: `CC-INV-01` (binding), `CC-INV-04` (evidence), `CC-INV-06` (delivery), `CC-INV-07` (ownership); implementation contract `CC-DISCORD-PHASE-TITLE-01`.

State owners remain unchanged: session repositories own current session status/work-phase; Discord channel repository owns scoped channel association; this adapter only projects the latest state onto the name. The existing pure title policy remains separate from Discord I/O. No new business-state cache or cross-domain write is introduced.

Acceptance:

1. Reconciliation reads only the Bot's active channel rows; retained inactive history does not trigger ownership/consultation reads.
2. Missing, inactive, non-thread and ended-session candidates are rejected before expensive ownership checks.
3. Stop, archive, ownership loss, session end and channel rebinding during asynchronous fetch still prevent stale renaming.
4. Locked summaries and current phase projection remain intact; unchanged names are not rewritten and failures remain retryable.

Changed source and tests are already paired under `cc.acceptance.json` implementations (`src/discord/forum-phase-sync.ts` / `.test.ts`) and both match existing `chat-platforms` membership. No duplicate mapping or domain was added. Spec text was updated before submission.

Verification performed: source/caller and SQL-plan inspection; read-only comparative measurements; branch/binding check; diff whitespace check. Regression tests were added for active-only enumeration, early rejection and session end during fetch. **Tests/typecheck/build/runtime reflection have not been executed by this session.** Current workflow requires explicit human permission for session-run tests. Revisor results, if later received, must be recorded separately.

Recovery: revert the targeted source/spec/test commit through normal review if behavior regresses. There is no schema/data migration or deleted history to restore. Reverting restores the previous full-history sweep, including its known latency cost. Authorized deployment and before/after runtime observation remain necessary.

## Investigation tools and unresolved integration

- `rg` was available and used to inspect concrete callers and implementations.
- Prepared Anatomia domain index was reachable at <http://127.0.0.1:4200/api/projects/concordia/domains>; `chat-platforms` was identified there and verified against the repository definition.
- Anatomia `plan --no-llm` was attempted but did not complete within 20 seconds; it reported invalid pre-existing definitions for `consultation-turn-status.domain.json` and `plan-approval-notification.domain.json`. No successful plan/verify result is claimed. `where`, `test-suggestions`, and `verify` were not completed.
- `typescript-language-server` was not found on PATH or in Cc's local `.bin`; no successful LSP call is claimed. Text/caller inspection was used instead.
- Registered Praeforma project endpoint was read: <http://127.0.0.1:8889/api/projects/01M1XZZMEXWTFCN4HKW8K7TJKM>. Repo UX/spec remains authoritative; no separate editable UX copy or human approval was created.
- Genius query was attempted from its own project directory after resolving its config requirement, but the service request failed. Recommendations above are the investigator's conclusions, not retrieved judgment cards.

## Remaining work / GO

1. GO: submit the prepared Cc fix through the existing local PR workflow and address review notifications; do not poll or duplicate an uncertain submission.
2. Pending: obtain/verify the corresponding Actio task when the service is available. Do not substitute legacy phase status.
3. Pending: authorized regression execution and runtime reflection; then observe periodic lag with the same metrics. A submitted PR or Test OK alone is not production completion.
4. Proposed next implementations, in order: Rv dashboard query narrowing; Rv list revision/query scope; Cc terminal reconciliation scope; transcript/index and queue summary changes. These are investigated proposals, not implemented changes.
5. Retention/archival requires an explicit policy decision only when proceeding to data removal; no such removal was performed.
