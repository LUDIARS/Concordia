/**
 * ホストメトリクスの周期サンプリングループ。
 */

import type { SessionsRepo } from "../db/sessions-repo.js";
import { createChildLogger } from "../shared/logger.js";
import { collectHostSnapshot } from "./collector.js";
import { MetricsStore } from "./store.js";

const log = createChildLogger("metrics");

export interface MetricsLoopHandle {
  stop: () => void;
}

export function startMetricsLoop(
  deps: { repo: SessionsRepo; store: MetricsStore },
  opts: { enabled: boolean; intervalMs: number; retentionHours: number },
): MetricsLoopHandle {
  if (!opts.enabled) {
    log.info("metrics loop disabled (CONCORDIA_METRICS_ENABLED=0)");
    return { stop: () => {} };
  }

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const snap = await collectHostSnapshot(deps.repo, Date.now());
      deps.store.insert(snap);
      deps.store.prune(Date.now() - opts.retentionHours * 3_600_000);
    } catch (err) {
      log.warn({ err: (err as Error).message }, "metrics tick failed");
    }
    if (!stopped) timer = setTimeout(() => void tick(), opts.intervalMs);
  };

  void tick();
  log.info({ intervalMs: opts.intervalMs }, "metrics loop started");

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
