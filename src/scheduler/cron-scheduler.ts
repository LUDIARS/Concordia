/**
 * 内部 cron スケジューラ。
 *
 * OS の Task Scheduler や外部の cloud routine に頼らず、 Concordia プロセス自身が
 * 実 cron 式 (croner) を評価して delegation を invoke する。
 * ジョブ定義は src/scheduler/cron-jobs.ts の固定リスト。
 */

import { Cron } from "croner";
import type { DelegationService } from "../delegation/service.js";
import { createChildLogger } from "../shared/logger.js";
import { CRON_JOBS, type CronJobDefinition } from "./cron-jobs.js";

const log = createChildLogger("cron-scheduler");
const TIMEZONE = "Asia/Tokyo";

export interface CronSchedulerDeps {
  delegationService: DelegationService;
  /**
   * cron 発火直前に呼ぶ、 call_name の実行時 override 解決 (WebUI `/v1/admin/cron-jobs` 経由)。
   * 未指定 / null を返せば job.call_name (cron-jobs.ts の既定) を使う。
   */
  resolveCallNameOverride?: (jobName: string) => string | null;
}

export interface CronSchedulerHandle {
  stop: () => void;
  /** テスト・手動起動用。 jobName 省略時は全ジョブを即時に1回実行する */
  triggerNow: (jobName?: string) => Promise<void>;
}

export function startCronScheduler(
  deps: CronSchedulerDeps,
  jobs: CronJobDefinition[] = CRON_JOBS,
): CronSchedulerHandle {
  async function runJob(job: CronJobDefinition): Promise<void> {
    const args = job.buildArgs();
    const call_name = deps.resolveCallNameOverride?.(job.name) ?? job.call_name;
    log.info({ job: job.name, call_name, default_call_name: job.call_name, args }, "cron job firing");

    const result = await deps.delegationService.invoke({
      call_name,
      args,
      cwd: "E:\\Document\\Ars",
      triggered_by: `cron:${job.name}`,
    });

    if (!result.ok) {
      log.warn({ job: job.name, error: result.error }, "cron job delegation invoke failed");
    } else {
      log.info(
        { job: job.name, runId: result.run.id, pid: result.spawn_pid },
        "cron job delegation spawned",
      );
    }
  }

  const crons = jobs.map(
    (job) =>
      new Cron(
        job.cron,
        {
          timezone: TIMEZONE,
          protect: true,
          catch: (err) => log.error({ job: job.name, err: (err as Error).message }, "cron job threw"),
        },
        () => runJob(job),
      ),
  );

  log.info(
    { jobs: jobs.map((j) => `${j.name} (${j.cron} ${TIMEZONE})`) },
    "cron scheduler started",
  );

  return {
    stop: () => {
      for (const c of crons) c.stop();
    },
    triggerNow: async (jobName?: string) => {
      const targets = jobName ? jobs.filter((j) => j.name === jobName) : jobs;
      for (const job of targets) await runJob(job);
    },
  };
}
