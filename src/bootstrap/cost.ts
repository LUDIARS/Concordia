import type Database from "better-sqlite3";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { DiscordConfigRepo } from "../db/discord-repo.js";
import { CostBudgetRepo } from "../cost/cost-budget-repo.js";
import { CostUsageTracker } from "../cost/usage-tracker.js";
import { cachedRecentLogTotals } from "../cost/log-totals-cache.js";
import { cachedChannelCostReader } from "../cost/channel-cost-cache.js";
import { collectUsageSamples } from "../cost/usage-sampler.js";
import { collectCostReport } from "../cost/cost-report.js";
import { collectLimitSamples } from "../cost/limit-sampler.js";
import { CostUsageSamplesRepo } from "../db/cost-usage-samples-repo.js";
import { CostLimitSamplesRepo } from "../db/cost-limit-samples-repo.js";
import { CostOneShotCallsRepo } from "../db/cost-one-shot-calls-repo.js";
import {
  readWorkerLease,
  startWorkerLease,
  WORKER_HEARTBEAT_MS,
  WORKER_LEASE_CHECK_MS,
  WORKER_LEASE_TTL_MS,
  type WorkerLease,
} from "../shared/worker-lease.js";

export type CostMode = "embedded" | "worker" | "off";

const COST_SAMPLE_INTERVAL_MS = 2 * 60 * 1000;
const USAGE_SAMPLE_INTERVAL_MS = 10 * 60 * 1000;
const USAGE_SAMPLE_RETENTION_SEC = 60 * 24 * 60 * 60;
const STARTUP_SAMPLE_DELAY_MS = readPositiveIntEnv("CONCORDIA_COST_STARTUP_SAMPLE_DELAY_MS", 2_000);
const COST_WORKER_LEASE_KEY = "cost_worker_lease";
const COST_WORKER_ROLE = "cost-sampler";

export const COST_WORKER_LEASE_TTL_MS = WORKER_LEASE_TTL_MS;
export const COST_WORKER_HEARTBEAT_MS = WORKER_HEARTBEAT_MS;
export const COST_WORKER_CHECK_MS = WORKER_LEASE_CHECK_MS;

export function readCostMode(env: NodeJS.ProcessEnv = process.env): CostMode {
  const raw = (env.CONCORDIA_COST_MODE ?? "").trim().toLowerCase();
  if (raw === "off" || raw === "worker") return raw;
  return "embedded";
}

export function costEmbeddedEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return readCostMode(env) === "embedded";
}

export function readCostWorkerLease(repo: DiscordConfigRepo, now: number = Date.now()): WorkerLease | null {
  return readWorkerLease(repo, {
    key: COST_WORKER_LEASE_KEY,
    role: COST_WORKER_ROLE,
    now,
    ttlMs: COST_WORKER_LEASE_TTL_MS,
  });
}

export function startCostWorkerLease(
  repo: DiscordConfigRepo,
  opts: { pid?: number; now?: () => number } = {},
): { stop(): void } {
  return startWorkerLease(repo, {
    key: COST_WORKER_LEASE_KEY,
    role: COST_WORKER_ROLE,
    pid: opts.pid,
    now: opts.now,
    heartbeatMs: COST_WORKER_HEARTBEAT_MS,
  });
}

export interface CostLeaseWatchDeps {
  mode: CostMode;
  runtime: Pick<CostRuntime, "isRunning" | "start" | "stop">;
  readLease: () => WorkerLease | null;
  log: { info: (msg: string) => void; warn: (msg: string) => void };
  /** worker モードで lease 失効を検知したときの通知。 1 停止につき 1 回だけ呼ぶ。 */
  reportWorkerDown: (lastLease: WorkerLease | null) => void;
}

/**
 * cost-worker lease の周期 watch tick。
 *
 * chat/workflow の worker watch と対称にする:
 * - lease が生きていれば embedded サンプラを止める (worker に譲る)。
 * - lease が失効したら、 embedded モードは自前サンプラを再開、
 *   worker モードは自動フォールバック先が無いので warn + reportWorkerDown で
 *   人間/errors チャンネルに可視化する (2026-07-15 に worker が黙って死に、
 *   cost 計測が数日止まっていた実害への対処)。
 */
export function createCostLeaseWatchTick(deps: CostLeaseWatchDeps): () => void {
  let workerDownReported = false;
  let lastLease: WorkerLease | null = null;
  return () => {
    const lease = deps.readLease();
    if (lease) {
      lastLease = lease;
      workerDownReported = false;
      if (deps.runtime.isRunning()) {
        deps.log.warn("live cost-worker lease detected; stopping embedded cost sampler");
        deps.runtime.stop();
      }
      return;
    }
    if (deps.mode === "embedded") {
      if (!deps.runtime.isRunning()) {
        deps.log.warn("cost-worker lease expired; restoring embedded cost sampler");
        deps.runtime.start();
      }
      return;
    }
    if (deps.mode === "worker" && !workerDownReported) {
      workerDownReported = true;
      deps.log.warn("cost-worker lease expired; cost sampling is down (worker mode has no auto-fallback)");
      deps.reportWorkerDown(lastLease);
    }
  };
}

export interface CostRuntimeDeps {
  db: Database.Database;
  sessionsRepo: SessionsRepo;
  getDailyTokenBudget: () => number;
  log?: { info: (msg: string) => void; warn: (msg: string) => void };
}

export interface CostRuntime {
  budgetRepo: CostBudgetRepo;
  tracker: CostUsageTracker;
  usageSamplesRepo: CostUsageSamplesRepo;
  limitSamplesRepo: CostLimitSamplesRepo;
  oneShotsRepo: CostOneShotCallsRepo;
  start(): void;
  stop(): void;
  isRunning(): boolean;
  sampleOnce(): void;
  sampleLimitsOnce(): Promise<void>;
}

export function createCostRuntime(deps: CostRuntimeDeps): CostRuntime {
  const budgetRepo = new CostBudgetRepo(deps.db);
  const tracker = new CostUsageTracker({
    repo: budgetRepo,
    getBudget: deps.getDailyTokenBudget,
    enumerate: cachedRecentLogTotals,
  });
  const usageSamplesRepo = new CostUsageSamplesRepo(deps.db);
  const limitSamplesRepo = new CostLimitSamplesRepo(deps.db);
  const oneShotsRepo = new CostOneShotCallsRepo(deps.db);

  let costSampleTimer: ReturnType<typeof setInterval> | null = null;
  let usageSampleTimer: ReturnType<typeof setInterval> | null = null;
  let limitSampleTimer: ReturnType<typeof setInterval> | null = null;
  let startupSampleTimer: ReturnType<typeof setTimeout> | null = null;

  const sampleOnce = (): void => {
    try {
      tracker.sample();
    } catch (e) {
      deps.log?.warn(`cost tracker sample failed: ${(e as Error).message}`);
    }
  };

  const sampleUsage = (): void => {
    try {
      const active = deps.sessionsRepo.listSessions({ status: "active" });
      const nowSec = Math.floor(Date.now() / 1000);
      usageSamplesRepo.insertMany(collectUsageSamples(active, nowSec, cachedChannelCostReader));
      usageSamplesRepo.pruneOlderThan(nowSec - USAGE_SAMPLE_RETENTION_SEC);
    } catch (e) {
      deps.log?.warn(`usage sampler failed: ${(e as Error).message}`);
    }
  };

  const sampleLimitsOnce = async (): Promise<void> => {
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      const report = await collectCostReport(deps.sessionsRepo, { oauthLog: deps.log });
      const previous = limitSamplesRepo.listLatestByProvider();
      limitSamplesRepo.insertMany(collectLimitSamples(report, nowSec, previous));
      limitSamplesRepo.pruneOlderThan(nowSec - USAGE_SAMPLE_RETENTION_SEC);
    } catch (e) {
      deps.log?.warn(`cost limit sampler failed: ${(e as Error).message}`);
    }
  };

  return {
    budgetRepo,
    tracker,
    usageSamplesRepo,
    limitSamplesRepo,
    oneShotsRepo,
    start() {
      if (costSampleTimer || usageSampleTimer || limitSampleTimer) return;
      startupSampleTimer = setTimeout(() => {
        startupSampleTimer = null;
        sampleOnce();
        sampleUsage();
        void sampleLimitsOnce();
      }, STARTUP_SAMPLE_DELAY_MS);
      startupSampleTimer.unref?.();
      costSampleTimer = setInterval(sampleOnce, COST_SAMPLE_INTERVAL_MS);
      usageSampleTimer = setInterval(sampleUsage, USAGE_SAMPLE_INTERVAL_MS);
      limitSampleTimer = setInterval(() => { void sampleLimitsOnce(); }, USAGE_SAMPLE_INTERVAL_MS);
      costSampleTimer.unref?.();
      usageSampleTimer.unref?.();
      limitSampleTimer.unref?.();
      deps.log?.info(`cost runtime sampling started (startup delay ${STARTUP_SAMPLE_DELAY_MS}ms)`);
    },
    stop() {
      if (startupSampleTimer) clearTimeout(startupSampleTimer);
      if (costSampleTimer) clearInterval(costSampleTimer);
      if (usageSampleTimer) clearInterval(usageSampleTimer);
      if (limitSampleTimer) clearInterval(limitSampleTimer);
      startupSampleTimer = null;
      costSampleTimer = null;
      usageSampleTimer = null;
      limitSampleTimer = null;
      deps.log?.info("cost runtime sampling stopped");
    },
    isRunning() {
      return costSampleTimer !== null || usageSampleTimer !== null || limitSampleTimer !== null;
    },
    sampleOnce,
    sampleLimitsOnce,
  };
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
