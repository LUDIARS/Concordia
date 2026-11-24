import type Database from "better-sqlite3";
import type { KaizenDay, KaizenFacts } from "../agent-jobs/kaizen-daily.js";
import type { CronJobDefinition } from "../cron-jobs.js";

/** Aggregate on the Cc connection. No source rows or free text leave this adapter. */
export function createKaizenFactsReader(db: Database.Database, jobs: readonly CronJobDefinition[]) {
  const args = {
    callNames: JSON.stringify([...new Set(jobs.map((job) => job.call_name))]),
    jobNames: JSON.stringify(jobs.map((job) => job.name)),
  };
  const failedRuns = db.prepare(`
    SELECT CASE WHEN call_name IN (SELECT value FROM json_each(@callNames)) THEN call_name ELSE 'other' END AS call_name,
      CASE WHEN status = 'spawn_failed' THEN 'spawn_failed'
           WHEN error IS NULL OR trim(error) = '' THEN 'unspecified'
           WHEN lower(error) LIKE '%timeout%' OR lower(error) LIKE '%timed out%' THEN 'timeout'
           WHEN lower(error) LIKE '%rate_limit%' OR lower(error) LIKE '%rate limit%' THEN 'rate_limit'
           WHEN lower(error) LIKE '%unauthorized%' OR lower(error) LIKE '%authentication%' THEN 'auth'
           ELSE 'failed' END AS reason,
      count(*) AS count
    FROM delegation_runs
    WHERE status IN ('failed', 'spawn_failed') AND finished_at >= @start AND finished_at < @end
    GROUP BY 1, 2 ORDER BY count DESC, call_name, reason
  `);
  const failedJobs = db.prepare(`
    WITH failures(job) AS (
      SELECT substr(triggered_by, 6, instr(substr(triggered_by, 6) || ':', ':') - 1)
      FROM delegation_runs
      WHERE status IN ('failed', 'spawn_failed') AND finished_at >= @start AND finished_at < @end
        AND triggered_by GLOB 'cron:*'
      UNION ALL
      SELECT json_extract(params, '$.job')
      FROM agent_instructions
      WHERE status = 'failed' AND finished_at >= @startIso AND finished_at < @endIso
        AND json_valid(params) AND json_extract(params, '$.dedupe_key') GLOB 'cron:*'
    )
    SELECT job, count(*) AS count FROM failures
    WHERE job IN (SELECT value FROM json_each(@jobNames))
    GROUP BY job ORDER BY count DESC, job
  `);
  const waiting = db.prepare(`
    SELECT count(*) AS count FROM control_cards
    WHERE raised_at < @endMs AND (closed_at IS NULL OR closed_at >= @endMs)
      AND (discarded_at IS NULL OR discarded_at >= @endMs)
  `);
  const denied = db.prepare(`
    SELECT kind, count(*) AS count FROM session_events
    WHERE ts >= @start AND ts < @end
      AND (kind = 'harness.task_branch.repeated_denial'
        OR (kind = 'push_hook_decision' AND json_valid(payload) AND json_extract(payload, '$.allowed') = 0))
    GROUP BY kind ORDER BY count DESC, kind
  `);
  const requeues = db.prepare(`
    SELECT CASE WHEN applied_at <= @start
      THEN COALESCE((SELECT count FROM agent_instruction_requeue_counts WHERE jst_date = @date), 0) END AS count
    FROM schema_migrations WHERE name = 'cron-agent-job-evidence'
  `);
  return ({ date, start, end }: KaizenDay): KaizenFacts => {
    const range = { start: start.getTime(), end: end.getTime() };
    return {
      failed_runs: failedRuns.all({ ...range, callNames: args.callNames }) as KaizenFacts["failed_runs"],
      failed_cron_jobs: failedJobs.all({
        ...range, startIso: start.toISOString(), endIso: end.toISOString(), jobNames: args.jobNames,
      }) as KaizenFacts["failed_cron_jobs"],
      human_waiting: (waiting.get({ endMs: range.end }) as { count: number }).count,
      instruction_requeues: (requeues.get({ start: range.start, date }) as { count: number | null } | undefined)?.count ?? null,
      hook_denials: denied.all({ start: range.start / 1000, end: range.end / 1000 }) as KaizenFacts["hook_denials"],
    };
  };
}
