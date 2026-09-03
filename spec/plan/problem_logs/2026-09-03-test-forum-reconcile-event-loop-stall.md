# Test Forum periodic reconcile stalls the event loop every 30 seconds

- Date: 2026-09-03
- Status: phase 1 implemented (fan-in + interval + instrumentation); phases 2–3 designed, not started
- Area: Discord Test Forum sync / Revisor read client / periodic jobs
- Severity: High — every session's Bash/Edit/Write is blocked by the fail-closed harness gate while the
  loop is stalled

## Summary

neco reported that `Concordia は時間内に応答しませんでした` was appearing more and more often. That
message is the `harness-gate` hook's fail-closed branch (`.claude/hooks/harness-gate.mjs`), which blocks
the tool call when `POST /v1/harness/gate` does not answer within 12,000 ms twice in a row. So the
user-visible symptom is "no session can edit files", and the cause is a stalled Concordia event loop.

The stall is the Test Forum periodic reconcile. It ran every **30 seconds**, once per Discord client
(head office plus each subsidiary — four in production), and each run fetched the Revisor local PR list
**twice** (`listOpenLocalPrs` and `listTerminalLocalPrs` both `GET /v1/local-prs`) plus
`GET /v1/repositories`, each preceded by an Excubitor catalog lookup. The local PR response is about
1 MB; parsing it happens on the main thread. Four clients × three list fetches every 30 seconds put
roughly 8 MB of JSON parsing plus twelve Excubitor round-trips on the event loop every half minute.

This is the same failure class as
`spec/tasks/2026-08-09-transcript-frame-event-loop-stall.md` and
`spec/plan/problem_logs/2026-08-23-concordia-event-loop-instability.md`: work performed on the main
thread stops HTTP, timers, and Discord handling together. The trigger is different each time, so the
durable fix is not only removing this trigger but making periodic jobs report their own cost.

## Evidence

Measured on 2026-09-03 against backend PID 62072 (started 12:47:45 JST, port 11111).

- 481 `event loop stalled` records in one hour, totalling 1,383 s of lag — **38 % of wall-clock time**.
- Stall clusters land on an exact 30.0 s grid: 05:24:37, 05:25:07, 05:25:37, 05:26:07, 05:26:37,
  05:27:07 … (UTC). Cluster length 2.6–6 s at rest, 16–49 s under load.
- The bracketing is unambiguous in `logs/concordia/cc-live.jsonl`:

  ```
  05:28:39.028 event loop stalled  lag_ms=1861
  05:28:39.618 test-forum periodic reconcile: … projectScopeCount=3
  05:28:40.567 test-forum periodic reconcile: … projectScopeCount=0
  05:28:41.054 test-forum periodic reconcile: scanned=65 kept=65 …
  05:28:41.077 event loop stalled  lag_ms=1147
  ```

  The same four-line block repeats 30.0 s later at 05:29:09–05:29:11.
- Sampling the backend process once a second: 130–150 % CPU for ~6 s on the grid, 0–5 % between bursts.
  The work is in-process CPU, not host starvation.
- `GET /v1/prs/revisor` logged `body_bytes=975515` — the size of the list each reconcile parses.
- 76 reconcile failures per hour, split between
  `Revisor request to 127.0.0.1:4240/v1/local-prs failed: timeout after 10000ms` and
  `Revisor returned an invalid local PR list response`. A failed run re-entered 30 s later regardless.
- Discord logged shard 0 reconnects in groups of four (one per client) at 05:01, 05:09 and 05:15 —
  missed heartbeats during the longest stalls, i.e. a consequence, not a cause.

### Ruled out

Each of these was measured and rejected, because the previous two incidents in this class had different
causes and assuming a repeat wastes the most time:

- **WAL growth** (the 2026-09-01 cause) — `concordia.db-wal` sits at exactly 64 MB, the
  `journal_size_limit` cap from `src/db/wal-guard.ts`. The guard is working.
- **Metrics tick** (the 2026-09-03 morning cause) — the indexed `sumTreeRssIndexed` path is live and the
  Excubitor snapshot is 288 KB / 60 ms to parse. Stall gaps do not match its cadence either.
- **Disk** — E: average queue length 0.22–0.33, normal latency.
- **Host CPU starvation** — the host is busy (84 % total, 42 % privileged) but the stalls sit on a
  30 s grid; scheduling pressure does not produce that.
- **SQLite lock contention / gate queries** — the gate's `harness_session_audit` DISTINCT queries run in
  0.2–14 ms against the live database.

## Fix

### Phase 1 — implemented here

1. **Fan-in the Revisor reads.** New `src/pr/revisor-read-cache.ts` (`SharedReadCache`) folds repeated
   reads of the same key into one upstream call with a TTL plus single-flight. `RevisorTestWorkflowClient`
   routes `/v1/test-workflow`, `/v1/local-prs`, `/v1/repositories` and the Excubitor catalog lookup
   through it (default TTL 5,000 ms). All Discord clients share one client instance
   (`discordBotDeps.revisorTestWorkflow`), so one reconcile round now costs one fetch and one parse of
   each list instead of one per client per call site. Failures are not cached, and every joiner receives
   the same error — no silent empty-list fallback.
2. **Keep the immediate path immediate.** `pr.changed` calls `invalidateReads()` before triggering the
   refresh, so the event-driven update never serves a cached list.
3. **Raise the periodic interval.** `CONCORDIA_DISCORD_TEST_FORUM_RECONCILE_SEC` default 30 → 300. The
   periodic run is a reconciliation sweep for missed events; `pr.changed` carries the latency requirement.
4. **Instrument the job.** The reconcile log line now carries `durationMs`. Identifying this job as the
   culprit required correlating stall timestamps with unrelated log lines by hand; a periodic job that
   does not report its own duration makes every future incident in this class equally expensive.

Expected effect: list fetches per 30 s drop from twelve to zero on nine ticks out of ten, and from twelve
to two on the tenth.

### Phase 2 — event-driven reconciliation (not started)

The periodic run rescans all 65 forum surfaces regardless of what changed. Drive updates from the
`pr.changed` event for the affected PR only, and keep a long-period (hourly) full sweep for drift.

### Phase 3 — move the job off the request loop (not started)

`chat-worker`, `control-worker` and `cost-worker` already run outside the HTTP process. The Discord
reconcile belongs in the same family: a job that blocks should not be able to take the harness gate — and
therefore every session's ability to edit files — down with it.

## Related

- `spec/tasks/2026-08-09-transcript-frame-event-loop-stall.md`
- `spec/plan/problem_logs/2026-08-23-concordia-event-loop-instability.md`
- `spec/plan/problem_logs/2026-08-31-subsidiary-discord-client-memory-amplification.md` — same
  per-subsidiary amplification shape, different resource
- `spec/feature/revisor-test-forum-sync.md`
