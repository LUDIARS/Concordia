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
import type { CronFanoutTarget } from "./cron-fanout.js";
import { CRON_JOBS, type CronJobDefinition, type CronJobFanout } from "./cron-jobs.js";

const log = createChildLogger("cron-scheduler");
const TIMEZONE = "Asia/Tokyo";

/** fanout 無しのジョブを 1 対象として扱うための擬似対象 (args / options の上書き無し)。 */
const SINGLE_TARGET: CronFanoutTarget[] = [{ key: "", args: {} }];

export interface CronSchedulerDeps {
  delegationService: DelegationService;
  /**
   * cron 発火直前に呼ぶ、 call_name の実行時 override 解決 (WebUI `/v1/admin/cron-jobs` 経由)。
   * 未指定 / null を返せば job.call_name (cron-jobs.ts の既定) を使う。
   */
  resolveCallNameOverride?: (jobName: string) => string | null;
  /**
   * `fanout` 付きジョブの対象列挙 (チームごとの朝礼・定例など)。 DB を引くため
   * 呼び出し側 (bootstrap) が渡す。 resolver が無い戦略のジョブは起動しない。
   */
  fanoutResolvers?: Partial<Record<CronJobFanout, () => CronFanoutTarget[]>>;
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
  /**
   * fanout 付きジョブの対象を解決する。 resolver 未登録なら null を返して起動を見送る
   * (対象不明のまま 1 本だけ起動すると、 チーム宛のはずの朝礼が宛先無しで走ってしまう)。
   */
  function resolveTargets(job: CronJobDefinition): CronFanoutTarget[] | null {
    if (!job.fanout) return SINGLE_TARGET;
    const resolver = deps.fanoutResolvers?.[job.fanout];
    if (!resolver) {
      log.warn({ job: job.name, fanout: job.fanout }, "cron job fanout resolver missing; skipping");
      return null;
    }
    return resolver();
  }

  async function runJob(job: CronJobDefinition): Promise<void> {
    const targets = resolveTargets(job);
    if (!targets) return;
    if (targets.length === 0) {
      log.info({ job: job.name, fanout: job.fanout }, "cron job has no fanout targets; skipping");
      return;
    }

    const baseArgs = job.buildArgs();
    const call_name = deps.resolveCallNameOverride?.(job.name) ?? job.call_name;

    for (const target of targets) {
      const args = { ...baseArgs, ...target.args };
      const triggered_by = target.key ? `cron:${job.name}:${target.key}` : `cron:${job.name}`;
      log.info(
        { job: job.name, call_name, default_call_name: job.call_name, target: target.key || null, args },
        "cron job firing",
      );

      try {
        const result = await deps.delegationService.invoke({
          call_name,
          args,
          // 未指定なら テンプレートの default_cwd が使われる (caller cwd は default_cwd より優先される)。
          cwd: job.cwd,
          triggered_by,
          ...(target.options ? { options: target.options } : {}),
        });

        if (!result.ok) {
          log.warn(
            { job: job.name, target: target.key || null, error: result.error },
            "cron job delegation invoke failed",
          );
          continue;
        }

        log.info(
          { job: job.name, target: target.key || null, runId: result.run.id, pid: result.spawn_pid },
          "cron job delegation spawned",
        );
      } catch (error) {
        // invoke 自体が reject / throw しても、1 対象の失敗で残りのチームを落とさない。
        log.warn(
          { job: job.name, target: target.key || null, error: (error as Error).message },
          "cron job delegation invoke threw",
        );
      }
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
