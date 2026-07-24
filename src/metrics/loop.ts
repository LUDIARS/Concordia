/**
 * ホストメトリクスの周期サンプリングループ。
 */

import type { SessionsRepo } from "../db/sessions-repo.js";
import type { ExcubitorClient } from "../excubitor/client.js";
import { createChildLogger } from "../shared/logger.js";
import { collectHostSnapshot } from "./collector.js";
import { MetricsStore } from "./store.js";
import { EventLoopLagSampler } from "./event-loop-lag.js";
import type { LagSnapshot } from "./event-loop-lag.js";
import { EventLoopLagAlert } from "./lag-alert.js";
import { createLoopBulkhead } from "../shared/loop-bulkhead.js";

const log = createChildLogger("metrics");

export interface MetricsLoopHandle {
  stop: () => void;
}

export function startMetricsLoop(
  deps: {
    repo: SessionsRepo;
    store: MetricsStore;
    excubitorClient?: ExcubitorClient;
    notifyLag?: (snapshot: LagSnapshot) => Promise<void> | void;
  },
  opts: { enabled: boolean; intervalMs: number; retentionHours: number },
): MetricsLoopHandle {
  if (!opts.enabled) {
    log.info("metrics loop disabled (CONCORDIA_METRICS_ENABLED=0)");
    return { stop: () => {} };
  }

  const lagSampler = new EventLoopLagSampler();
  let lagSamplerEnabled = false;

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const startDelayMs = readNonNegativeIntEnv("CONCORDIA_METRICS_START_DELAY_MS", 30_000);
  const lagAlert = new EventLoopLagAlert({
    thresholdMs: readPositiveIntEnv("CONCORDIA_EVENT_LOOP_LAG_ALERT_MS", 200),
    consecutiveSamples: readPositiveIntEnv("CONCORDIA_EVENT_LOOP_LAG_ALERT_SAMPLES", 3),
    cooldownMs: readPositiveIntEnv("CONCORDIA_EVENT_LOOP_LAG_ALERT_COOLDOWN_MS", 10 * 60_000),
    notify: deps.notifyLag ?? (() => undefined),
  });
  const bulkhead = createLoopBulkhead("metrics", {
    log: { warn: (message) => log.warn(message) },
    onHalt: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (lagSamplerEnabled) lagSampler.disable();
    },
  });

  const tick = async (): Promise<void> => {
    if (stopped) return;
    await bulkhead.run(async () => {
      if (!lagSamplerEnabled) {
        lagSampler.enable();
        lagSamplerEnabled = true;
      }
      const lagSnap = lagSampler.snapshot();
      lagAlert.observe(lagSnap);
      const snap = await collectHostSnapshot(deps.repo, Date.now(), deps.excubitorClient);
      snap.eventLoopLag = lagSnap;
      deps.store.insert(snap);
      deps.store.prune(Date.now() - opts.retentionHours * 3_600_000);
    });
    if (!stopped && !bulkhead.isHalted()) timer = setTimeout(() => void tick(), opts.intervalMs);
  };

  timer = setTimeout(() => void tick(), startDelayMs);
  timer.unref?.();
  log.info({ intervalMs: opts.intervalMs, startDelayMs }, "metrics loop started");

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (lagSamplerEnabled) lagSampler.disable();
    },
  };
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function readNonNegativeIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}
