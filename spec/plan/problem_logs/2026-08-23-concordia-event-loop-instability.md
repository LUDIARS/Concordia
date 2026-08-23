# Concordia event-loop instability under delegation and retention load

- Date: 2026-08-23
- Status: investigating
- Area: HTTP API / SQLite read model / log retention / Discord relay
- Severity: High — the health endpoint stays green while API and Discord work can pause for tens of seconds

## Summary

neco reported that Concordia is unstable. The backend is currently reachable and `/health` reports
`ok: true`, but the production log shows repeated event-loop stalls and very slow API requests. This is
a regression of the event-loop blocking class documented in
`spec/tasks/2026-08-09-transcript-frame-event-loop-stall.md`: work performed synchronously in the main
Node.js process can stop HTTP, WebSocket, timers, and Discord handling together.

The strongest current trigger is `GET /v1/delegation/runs`. The route synchronously loads runs (100 by
default, up to 500 via `limit`) and up to 1,000 delegation sessions, then `linkedSessionsForRun()` scans
the full session array for every run and reparses `session.metadata` inside the nested loop. Retention
work also reads, serializes,
compresses, writes, and deletes old rows every 60 seconds in the backend process. These paths share the
same event loop and the same 1.5 GB SQLite database.

## Evidence

Production snapshot on 2026-08-23 JST:

- Concordia health was green and reported `started_at=2026-08-22T05:46:10.084Z`.
- PID 25380 held port 11111 and used about 508 MB working set / 580 MB private memory.
- `concordia.db` was 1,501,597,696 bytes, with a 5,413,712-byte WAL. SQLite reported 366,601 pages and
  100,277 free-list pages (about 392 MiB at 4 KiB per page).
- From backend PID 25380's `cc-live.jsonl`, 445 `event loop stalled` records occurred between startup and
  the 2026-08-23 investigation. Lag was 1,002–147,102 ms, average 5,654.4 ms.
- `GET /v1/delegation/runs` had 59 slow requests: average 3,244 ms and maximum 48,717 ms.
- At 2026-08-23 09:25:23 JST, `/v1/delegation/runs` completed in 48,717 ms and the backend logged a
  48,766 ms event-loop stall 27 ms later.
- At 2026-08-23 09:35:53–09:35:55 JST, `/v1/delegation/runs` completed in 45,526 ms and the backend logged
  a 50,833 ms event-loop stall.
- Session endpoints also reached 106,948 ms and 96,296 ms. `/v1/sessions` reached 44,879 ms; local PR and
  session-end paths regularly took tens of seconds.
- Discord logged 71 shard reconnects and 50 webhook send failures. Several webhook failures were HTTP
  400 `USERNAME_INVALID_CONTAINS` because the generated username contained `discord`; one timed out
  immediately after a 50.8-second event-loop stall.
- `log-archive/` contained 1,792 ZIP files totaling 9,810,489 bytes, dated from 2026-08-22 19:11:53 to
  2026-08-23 09:38:58. The sweeper was creating two or three tiny archives most minutes. Current-process
  logs recorded 830 transcript archive batches (32,279 rows), 679 rules-log batches (1,222 rows), and 773
  session-stat batches (1,169 rows).
- A historical repository log from 2026-08-22 showed many simultaneous `control-worker` PIDs repeatedly
  failing `ControlJobsRepo.claimNext()` with `SQLITE_BUSY: database is locked`. The current snapshot has
  one control worker, so that worker storm is not the immediate live cause, but singleton enforcement is
  still a required regression guard.

Relevant implementation:

- `src/api/delegation.ts` — `/runs` and `linkedSessionsForRun()`. `GET /runs/:id` calls the same
  `listDelegationSessions()` + `linkedSessionsForRun()` pair, so it loads every delegation session to
  resolve one run and shares the same defect at smaller scale.
- `src/db/sessions-repo.ts` — `listDelegationSessions()` performs a metadata `LIKE` table scan and temp
  B-tree sort. `EXPLAIN QUERY PLAN` reports `SCAN sessions` and `USE TEMP B-TREE FOR ORDER BY`.
- `src/db/log-archive.ts` — synchronous `better-sqlite3` reads/deletes and in-process ZIP construction.
- `src/sweeper.ts` — runs all retention targets every 60 seconds in the backend.
- `src/db/schema.ts` — `busy_timeout = 5000`; waiting on SQLite contention blocks the Node event loop.

The live database had 1,048 session rows, 863 matching delegation metadata, and 659 delegation runs.
The current route can therefore do roughly 86,300 session comparisons and repeated JSON parses for one
default 100-run request, synchronously on the HTTP event loop.

## Regression Context

The 2026-08-09 event-loop incident established that large synchronous SQLite work in the backend stalls
transcript ingestion and all other request handling. The later archive implementation added chunk yields,
but still performs selection, JSON serialization, ZIP construction, and deletion in the main process and
runs every minute. The new delegation runs UI/read model adds another unbounded synchronous scan/parse
path. The same failure mode has therefore returned through different code paths.

## Cause

Leading diagnosis: Concordia's main process performs too much synchronous CPU and SQLite work per request
and per sweeper tick. `GET /v1/delegation/runs` is the clearest reproducible-by-telemetry trigger: its
request durations align directly with major event-loop stalls, and its implementation is an O(runs ×
sessions) nested scan with repeated JSON parsing. The large, fragmented database and concurrent worker
writes amplify latency because `better-sqlite3` and its busy timeout block the event loop.

The per-minute archive policy is a secondary amplifier and storage-management defect. It creates thousands
of tiny ZIP files and performs retention work continuously instead of accumulating a useful batch or
running outside the serving process.

Discord reconnects and webhook timeouts are downstream symptoms of the stalled event loop. The invalid
webhook username is a separate deterministic relay bug that causes message loss even when the event loop
is healthy.

## Fix Requirements

1. Replace the `/v1/delegation/runs` nested scan with a bounded read model keyed by
   `delegation_run_id` / `child_session_id`. Parse each session metadata value at most once, or persist and
   index the linkage instead of discovering it with `LIKE` and JSON parsing on every request. Apply the
   same read model to `GET /v1/delegation/runs/:id` so the single-run path stops loading every delegation
   session.
2. Keep synchronous SQLite and serialization work below the existing event-loop thresholds. Expensive
   aggregation, archival, and compression must not run on the HTTP/Discord event loop.
3. Batch retention into materially sized archives and avoid creating one ZIP per table per minute for one
   or two rows. Preserve the archive-before-delete guarantee.
4. Add database maintenance/compaction policy that handles free-list growth without blocking the live
   backend.
5. Enforce a single active backend and one worker per singleton service across Excubitor reconciliation and
   restarts; a repeated worker storm must not contend on `control_jobs` again.
6. Sanitize webhook usernames before Discord submission, including the reserved `discord` substring, and
   keep relay failure visible to the originating session.
7. Keep test-process logs separate from the production `cc-live.jsonl`; inherited production log settings
   currently mix test PIDs and synthetic failures into the operational stream.

## Verification

No unit, integration, load, or startup tests were run during this investigation, per session policy.

Required regression coverage:

- Benchmark the delegation runs read model with at least 1,000 sessions and 500 runs. Polling the endpoint
  must not produce an event-loop stall above 200 ms, and request latency must remain bounded while
  transcript frames are ingested concurrently.
- Exercise sweeper retention against a database at least as large as the 1.5 GB production snapshot while
  HTTP, WebSocket, and Discord relay traffic continues; verify no long stall and no per-minute tiny-file
  explosion.
- Run concurrent backend, cost worker, and control worker writes and verify no worker duplication,
  `SQLITE_BUSY` storm, dropped transcript flush, or long busy-timeout stall.
- Verify reserved Discord username inputs are sanitized and relayed successfully.
- Verify operational log aggregation excludes test runner PIDs unless explicitly selected.

## Follow-up

- Implement the delegation read-model fix first; it has the strongest timestamp-level correlation with the
  live stalls.
- Move or redesign archival work next, then compact the database during a separately claimed maintenance
  window.
- Review Excubitor singleton reconciliation for the historical control-worker storm.
- Treat `/health` as insufficient for this incident class; expose event-loop lag and critical route latency
  in readiness/monitoring without making transient diagnostic noise an outage by itself.
